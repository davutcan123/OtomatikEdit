"""Real-render regressions for equivalent fast paths and animated opacity."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient


class RenderGraphOptimizationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="render-graph-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        with patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "render-graph-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1",
        }):
            spec = importlib.util.spec_from_file_location("render_graph_test_app", Path(__file__).with_name("app.py"))
            cls.backend = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.backend)
        if not shutil.which(cls.backend.FFMPEG_BIN):
            raise unittest.SkipTest("FFmpeg is required for render graph integration tests")
        cls.headers = {"X-Desktop-Token": "render-graph-test"}
        cls.file_id = "green.mp4"
        subprocess.run([
            cls.backend.FFMPEG_BIN, "-y", "-v", "error", "-f", "lavfi", "-i",
            "color=lime:s=160x90:r=30:d=16", "-f", "lavfi", "-i",
            "sine=frequency=440:sample_rate=48000:duration=16", "-c:a", "aac",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(Path(cls.backend.UPLOAD_DIR) / cls.file_id),
        ], check=True, timeout=20)

    def render(self, settings):
        captured = []
        original = self.backend.create_media_process

        async def capture(*args, **kwargs):
            captured.append(list(args))
            return await original(*args, **kwargs)

        with patch.object(self.backend, "create_media_process", side_effect=capture):
            with TestClient(self.backend.app) as client:
                response = client.post("/start-render", headers=self.headers, data={
                    "file_id": self.file_id,
                    "segments": json.dumps([{"fileId": self.file_id, "start": 0, "end": 1,
                                              "fit": "contain", **settings}]),
                    "width": "160", "height": "90", "fps": "30", "fmt": "mp4",
                    "quality": "high", "hardware": "cpu",
                })
                self.assertEqual(response.status_code, 200, response.text)
                job_id = response.json()["job_id"]
                events = client.get("/stream-events/" + job_id, headers=self.headers)
                messages = [json.loads(line[6:]) for line in events.text.splitlines() if line.startswith("data: ")]
                self.assertFalse([item for item in messages if item.get("type") == "error"], messages)
                self.assertTrue(any(item.get("download_url") for item in messages), messages)
        command = next(command for command in reversed(captured) if "-map" in command)
        self.last_command = command
        script = next(command[index + 1] for index, value in enumerate(command)
                      if value in {"-filter_complex_script", "-/filter_complex"})
        output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.mp4"
        return Path(script).read_text(), output

    def green_level(self, output, time):
        result = subprocess.run([
            self.backend.FFMPEG_BIN, "-v", "error", "-ss", str(time), "-i", str(output),
            "-frames:v", "1", "-vf", "crop=2:2:78:44", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
        ], capture_output=True, check=True, timeout=20)
        return sum(result.stdout[1::3]) / 4

    def test_opaque_contain_skips_identity_pixel_expression(self):
        graph, output = self.render({"opacity": 100})
        self.assertNotIn("geq=", graph)
        self.assertGreater(self.green_level(output, .5), 245)

    def test_fixed_opacity_keeps_alpha_processing(self):
        graph, output = self.render({"opacity": 50})
        self.assertIn("alpha(X,Y)", graph)
        self.assertTrue(110 < self.green_level(output, .5) < 145)

    def test_animated_opacity_keeps_alpha_processing_and_changes_frames(self):
        graph, output = self.render({"opacity": 100, "zoomKeyframes": [
            {"time": 0, "scale": 100, "opacity": 0},
            {"time": 1, "scale": 100, "opacity": 100, "easing": "linear"},
        ]})
        self.assertIn("alpha(X,Y)", graph)
        self.assertLess(self.green_level(output, .1), 45)
        self.assertGreater(self.green_level(output, .8), 185)

    def test_trimmed_compressed_audio_retains_every_pcm_sample(self):
        # AAC uses overlapping decode windows and discard-padding metadata.
        # Demux seeking can subtly alter the first/last decoded samples even
        # when the output duration and video frame hashes still match.
        graph, _ = self.render({"start": 12, "end": 16})
        command = self.last_command
        script_index = next(index + 1 for index, value in enumerate(command)
                            if value in {"-filter_complex_script", "-/filter_complex"})
        audio_graph = Path(self.temporary.name) / "audio-only.txt"
        audio_graph.write_text(graph + ";\n[outv]nullsink")
        audio_command = command[:command.index("-map")]
        audio_command[script_index] = str(audio_graph)
        actual = subprocess.run(audio_command + ["-map", "[outa]", "-c:a", "pcm_s16le", "-f", "s16le", "-"],
                                capture_output=True, check=True, timeout=20).stdout
        expected = subprocess.run([
            self.backend.FFMPEG_BIN, "-v", "error", "-i", str(Path(self.backend.UPLOAD_DIR) / self.file_id),
            "-af", "atrim=start=12:end=16,asetpts=PTS-STARTPTS,atempo=1.00000000,volume=1.000000",
            "-vn", "-c:a", "pcm_s16le", "-f", "s16le", "-",
        ], capture_output=True, check=True, timeout=20).stdout
        self.assertEqual(len(actual), 4 * 48000 * 2)
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
