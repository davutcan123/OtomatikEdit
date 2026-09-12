"""Synthetic FFmpeg integration checks for edited current-frame capture."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image


class SnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {
            "SMART_EDITOR_DESKTOP": "1", "SMART_EDITOR_DESKTOP_TOKEN": "snapshot-test",
            "SMART_EDITOR_DATA_DIR": cls.temporary.name, "SMART_EDITOR_LEGACY_DIR": "",
            "SMART_EDITOR_LOW_MEMORY_RENDER": "1",
        })
        cls.environment.start()
        spec = importlib.util.spec_from_file_location("snapshot_test_app", Path(__file__).with_name("app.py"))
        cls.backend = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.backend)
        cls.headers = {"X-Desktop-Token": "snapshot-test"}
        if not shutil.which(cls.backend.FFMPEG_BIN):
            raise unittest.SkipTest("FFmpeg is needed for snapshot integration tests")
        cls.uploads = Path(cls.backend.UPLOAD_DIR)
        for name, source in {
            "halves.mp4": "color=red:s=320x180:r=30:d=4,drawbox=x=160:y=0:w=160:h=180:c=blue:t=fill",
            "green.mp4": "color=lime:s=320x180:r=30:d=4",
            "time.mp4": "color=blue:s=320x180:r=30:d=4,drawbox=x=0:y=0:w=320:h=180:c=red:t=fill:enable='gte(t,1)'",
            "long.mp4": "color=blue:s=320x180:r=30:d=70,drawbox=x=0:y=0:w=320:h=180:c=red:t=fill:enable='gte(t,50)'",
        }.items():
            subprocess.run([cls.backend.FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source,
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.uploads / name)], check=True, timeout=20)
        Image.new("RGB", (60, 60), "blue").save(cls.uploads / "overlay.png")
        Image.new("RGB", (120, 40), "blue").save(cls.uploads / "wide.png")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.temporary.cleanup()

    def capture(self, client, segments, at, **extra):
        payload = {"file_id": segments[0]["fileId"], "segments": json.dumps(segments), "timeline_time": str(at),
                   "width": "320", "height": "180", "canvas_width": "320", "canvas_height": "180", "fps": "30", **extra}
        response = client.post("/start-snapshot", data=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()["job_id"]
        response = client.get("/stream-events/" + job_id, headers=self.headers)
        messages = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        errors = [message for message in messages if message.get("type") == "error"]
        self.assertFalse(errors, errors)
        result = next(message for message in messages if message.get("type") == "result")
        self.assertEqual(result["download_url"], f"/download/{job_id}/png")
        self.assertTrue((Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.png").is_file())
        output = client.get(result["download_url"], headers=self.headers)
        self.assertEqual(output.status_code, 200)
        self.assertEqual(output.headers["content-type"], "image/png")
        return Image.open(io.BytesIO(output.content)).convert("RGB"), self.backend.jobs[job_id]

    def test_snapshot_uses_nonzero_source_time_and_only_a_short_window(self):
        with TestClient(self.backend.app) as client:
            image, job = self.capture(client, [{"fileId": "time.mp4", "start": 0, "end": 4, "timelineStart": 0}], 2.0)
            red, green, blue = image.getpixel((100, 90))
            self.assertGreater(red, 200)
            self.assertLess(blue, 20)
            self.assertLess(job["video_inputs"][0]["snapshot_duration"], 1)
            self.assertGreater(job["video_inputs"][0]["snapshot_seek"], 1)
            self.assertNotIn("png", self.backend.ALLOWED_FORMATS)

    def test_long_timeline_trim_and_speed_seek_into_short_source_window(self):
        clips = [{"fileId": "long.mp4", "start": 40, "end": 70, "speed": 2, "timelineStart": 5000}]
        with TestClient(self.backend.app) as client:
            image, job = self.capture(client, clips, 5009)
            self.assertGreater(image.getpixel((100, 90))[0], 220)
            self.assertAlmostEqual(job["video_inputs"][0]["snapshot_seek"], 57)
            self.assertLessEqual(job["video_inputs"][0]["snapshot_duration"], 1.5)
            image, _ = self.capture(client, [{**clips[0], "reverse": True}], 5009)
            self.assertGreater(image.getpixel((100, 90))[0], 220)

    def test_snapshot_transition_overlay_and_keyframes_at_original_timeline_time(self):
        clips = [
            {"fileId": "halves.mp4", "start": 0, "end": 2, "timelineStart": 0,
             "zoomKeyframes": [{"time": 0, "scale": 100, "x": 50}, {"time": 1.5, "scale": 200, "x": 25}]},
            {"fileId": "green.mp4", "start": 0, "end": 2, "timelineStart": 2},
        ]
        with TestClient(self.backend.app) as client:
            image, job = self.capture(client, clips, 1.75,
                transitions=json.dumps([{"boundary": 0, "type": "fade", "duration": .5}]),
                images=json.dumps([{"fileId": "overlay.png", "start": 1.5, "end": 2, "x": 50, "y": 50, "scale": 25}]),
                texts=json.dumps([{"text": "TEST", "start": 1, "end": 2, "size": 24, "x": 50, "y": 15,
                                   "outlineWidth": 0, "shadow": False,
                                   "transformKeyframes": [{"time": 0, "scale": 80, "x": 50, "y": 15, "opacity": 0},
                                                          {"time": .5, "scale": 100, "x": 50, "y": 15, "opacity": 100}]}]))
            red, green, blue = image.getpixel((280, 130))
            self.assertTrue(75 < red < 180 and 75 < green < 180 and blue < 30, (red, green, blue))
            self.assertGreater(image.getpixel((160, 90))[2], 230)
            self.assertGreater(sum(min(pixel) > 210 for pixel in image.crop((90, 0, 230, 60)).getdata()), 30)
            self.assertEqual(len(job["video_inputs"]), 2)
            self.assertAlmostEqual(job["snapshot"]["transition_elapsed"], .25)

    def test_opacity_and_fade_use_original_clip_time(self):
        with TestClient(self.backend.app) as client:
            clips = [{"fileId": "time.mp4", "start": 0, "end": 4, "timelineStart": 0,
                      "animation": "fadein", "animationDuration": 1,
                      "zoomKeyframes": [{"time": 0, "scale": 100, "opacity": 0},
                                         {"time": 1.5, "scale": 100, "opacity": 50}]}]
            image, _ = self.capture(client, clips, 2)
            self.assertTrue(100 < image.getpixel((160, 90))[0] < 150, image.getpixel((160, 90)))
            image, job = self.capture(client, [{"fileId": "time.mp4", "start": 0, "end": 4}], 999)
            self.assertGreater(image.getpixel((100, 90))[0], 200)
            self.assertLess(job["snapshot"]["timeline_time"], 4)

    def test_regular_video_render_still_outputs_h264(self):
        with TestClient(self.backend.app) as client:
            payload = {"file_id": "green.mp4", "segments": json.dumps([{"fileId": "green.mp4", "start": 0, "end": .5}]),
                       "width": "320", "height": "180", "fmt": "mp4"}
            response = client.post("/start-render", data=payload, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            job_id = response.json()["job_id"]
            events = client.get("/stream-events/" + job_id, headers=self.headers).text
            self.assertNotIn('"type": "error"', events, events)
            self.assertIn(f"/download/{job_id}/mp4", events)
            output = Path(self.backend.OUTPUT_DIR) / f"out_{job_id}.mp4"
            probe = subprocess.run([self.backend.FFPROBE_BIN, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_frames", "-of", "json", str(output)], capture_output=True, text=True, check=True)
            stream = json.loads(probe.stdout)["streams"][0]
            self.assertEqual(stream["codec_name"], "h264")
            self.assertEqual(int(stream["nb_frames"]), 15)

    def test_gap_and_post_transition_times_remain_in_editor_coordinates(self):
        clips = [{"fileId": "green.mp4", "start": 0, "end": 1, "timelineStart": 0},
                 {"fileId": "time.mp4", "start": 0, "end": 3, "timelineStart": 2}]
        with TestClient(self.backend.app) as client:
            image, job = self.capture(client, clips, 1.5)
            self.assertEqual(image.getpixel((160, 90)), (0, 0, 0))
            self.assertEqual(job["video_inputs"], [])
            image, _ = self.capture(client, clips, 4)
            self.assertGreater(image.getpixel((160, 90))[0], 220)

    def test_layers_extend_snapshot_past_last_video_and_stickers_remain_distinct(self):
        clips = [{"fileId": "green.mp4", "start": 0, "end": 1}]
        with TestClient(self.backend.app) as client:
            image, job = self.capture(client, clips, 3,
                images=json.dumps([{"fileId": "overlay.png", "start": 2, "end": 4, "scale": 20}]),
                stickers=json.dumps([{"preset": "heart", "start": 2, "end": 4, "x": 20, "y": 50, "scale": 18},
                                     {"preset": "star", "start": 2, "end": 4, "x": 80, "y": 50, "scale": 18}]),
                texts=json.dumps([{"text": "AFTER", "start": 2, "end": 4, "size": 24, "y": 15,
                                   "outlineWidth": 0, "shadow": False}]))
            self.assertEqual(job["snapshot"]["timeline_time"], 3)
            self.assertEqual(job["video_inputs"], [])
            self.assertEqual(image.getpixel((10, 160)), (0, 0, 0))
            self.assertGreater(image.getpixel((160, 90))[2], 220)
            heart = image.getpixel((64, 90))
            star = image.getpixel((256, 90))
            self.assertGreater(heart[0], heart[1] + 100)
            self.assertGreater(star[1], heart[1] + 80)
            self.assertGreater(sum(min(pixel) > 210 for pixel in image.crop((70, 0, 250, 55)).getdata()), 50)

    def test_rotated_image_and_offset_video_mask_geometry(self):
        with TestClient(self.backend.app) as client:
            clips = [{"fileId": "green.mp4", "start": 0, "end": 4}]
            image, _ = self.capture(client, clips, 2,
                images=json.dumps([{"fileId": "wide.png", "start": 1, "end": 3,
                                     "scale": 37.5, "rotation": 90}]))
            blue_pixels = [(x, y) for y in range(180) for x in range(320)
                           if image.getpixel((x, y))[2] > 200 and image.getpixel((x, y))[1] < 30]
            bounds = (min(p[0] for p in blue_pixels), min(p[1] for p in blue_pixels),
                      max(p[0] for p in blue_pixels), max(p[1] for p in blue_pixels))
            self.assertAlmostEqual(bounds[2] - bounds[0] + 1, 40, delta=3)
            self.assertAlmostEqual(bounds[3] - bounds[1] + 1, 120, delta=3)
            image, _ = self.capture(client, [{**clips[0], "mask": "circle", "maskScale": 40,
                                              "maskX": 25, "maskY": 50}], 2)
            self.assertGreater(image.getpixel((80, 90))[1], 220)
            self.assertEqual(image.getpixel((240, 90)), (0, 0, 0))
            self.assertEqual(image.getpixel((80, 5)), (0, 0, 0))

    def test_real_4k_png_preserves_source_canvas_text_and_effect_proportions(self):
        clips = [{"fileId": "green.mp4", "start": 0, "end": 4, "effect": "noir"}]
        text = json.dumps([{"text": "SIZE", "start": 1, "end": 3, "size": 24,
                            "color": "#FF0000", "outlineWidth": 0, "shadow": False}])
        with TestClient(self.backend.app) as client:
            small, _ = self.capture(client, clips, 2, texts=text)
            large, _ = self.capture(client, clips, 2, texts=text, width="3840", height="2160")
            self.assertEqual(large.size, (3840, 2160))
            background = large.getpixel((100, 100))
            self.assertLess(max(background) - min(background), 4)
            def text_bounds(image):
                red = image.getchannel("R")
                green = image.getchannel("G")
                from PIL import ImageChops
                return ImageChops.subtract(red, green).point(lambda value: 255 if value > 100 else 0).getbbox()
            small_box, large_box = text_bounds(small), text_bounds(large)
            self.assertIsNotNone(small_box)
            self.assertIsNotNone(large_box)
            # Font hinting and chroma subsampling differ by a pixel at the tiny
            # reference size; compare normalized extents rather than exact ink.
            self.assertAlmostEqual((large_box[2] - large_box[0]) / 12, small_box[2] - small_box[0], delta=2)
            self.assertAlmostEqual((large_box[3] - large_box[1]) / 12, small_box[3] - small_box[1], delta=2)

    def test_snapshot_rejects_nonfinite_time_and_normal_render_png(self):
        with TestClient(self.backend.app) as client:
            payload = {"file_id": "time.mp4", "segments": json.dumps([{"fileId": "time.mp4", "start": 0, "end": 2}])}
            self.assertEqual(client.post("/start-snapshot", data={**payload, "timeline_time": "nan"}, headers=self.headers).status_code, 400)
            self.assertEqual(client.post("/start-render", data={**payload, "fmt": "png"}, headers=self.headers).status_code, 400)

    def test_saved_project_delete_is_recoverable_and_keeps_uploads(self):
        project_id = str(uuid.uuid4())
        project = Path(self.backend.PROJECT_DIR) / f"{project_id}.json"
        contents = json.dumps({"id": project_id, "timelines": [], "mediaAssets": [{"fileId": "time.mp4"}]})
        project.write_text(contents)
        with TestClient(self.backend.app) as client:
            response = client.delete("/projects/" + project_id, headers=self.headers)
            self.assertEqual(response.json(), {"deleted": True, "recoverable": True})
            self.assertFalse(project.exists())
            copies = list((project.parent / ".trash").glob(project_id + "-*.json"))
            self.assertEqual(len(copies), 1)
            self.assertEqual(copies[0].read_text(), contents)
            self.assertTrue((self.uploads / "time.mp4").exists())


if __name__ == "__main__":
    unittest.main()
