"""Unit checks for the clocks and stream spans shared by the render graphs."""
import unittest

from render_audio import clip_audio_filter, join_audio, mix_audio_layers
from render_timing import (ClipClock, TimelineClip, normalize_zoom_cadence, plan_render_timing,
                           plan_video_frames, snapshot_source_window, source_frame_samples)


class RenderTimingTests(unittest.TestCase):
    def test_clip_clock_converts_in_both_directions_at_changed_speed(self):
        for reverse, times in ((False, (10, 12.5, 20)), (True, (20, 17.5, 10))):
            with self.subTest(reverse=reverse):
                clock = ClipClock(10, 20, 2.5, reverse)
                self.assertEqual(clock.duration, 4)
                for elapsed, source in zip((0, 1, 4), times):
                    self.assertEqual(clock.source_time(elapsed), source)
                    self.assertEqual(clock.output_time(source), elapsed)

    def test_preroll_uses_available_source_and_reports_remaining_output_seconds(self):
        forward = TimelineClip(ClipClock(.5, 5.5, 2, False), .25, .75)
        reverse = TimelineClip(ClipClock(2, 7, 2, True), .25, .75)
        self.assertEqual(forward.duration, 3.5)
        self.assertEqual(reverse.duration, 3.5)
        for timing, bounds, seek in ((forward, (0, 5.5), 0), (reverse, (2, 7.5), 7)):
            with self.subTest(reverse=timing.clock.reverse):
                trim = timing.source_trim(7.5)
                self.assertEqual((trim.start, trim.end), bounds)
                self.assertEqual(trim.missing_handle, .5)
                window = snapshot_source_window(timing.clock, -.75, 7.5, allow_preroll=True)
                self.assertEqual(window.source_start, seek)
                self.assertEqual(window.source_duration, .5)

    def test_render_and_snapshot_plan_respect_gaps_tracks_and_overlap(self):
        sections = [
            {"start": 1, "end": 7, "speed": 2, "timelineStart": 1},
            {"start": 3, "end": 5, "videoTrack": 2, "timelineStart": 1},
            {"start": 2, "end": 3, "timelineStart": 4},
        ]
        transitions = [{"boundary": 0, "duration": .25}]
        multitrack = plan_render_timing(sections, transitions, multitrack=True, layer_duration=6)
        self.assertEqual([clip.duration for clip in multitrack.clips], [4, 3, 1.25])
        self.assertEqual(multitrack.video_duration, 5)
        self.assertEqual(multitrack.output_duration, 6)
        single = plan_render_timing([sections[0], sections[2]], transitions, multitrack=False, layer_duration=0)
        self.assertEqual([clip.duration for clip in single.clips], [4, 1])
        self.assertEqual(single.output_duration, 4.75)
        snapshot = plan_render_timing(sections, [], multitrack=True, layer_duration=6, snapshot_fps=24)
        self.assertEqual(snapshot.output_duration, 1 / 24)

    def test_video_spans_quantize_cumulative_positions_instead_of_each_duration(self):
        sections = [
            {"start": 0, "end": .55, "timelineStart": .24},
            {"start": .07, "end": .55, "speed": 1.3, "timelineStart": .79},
            {"start": 0, "end": .51, "timelineStart": .79 + .48 / 1.3},
        ]
        timing = plan_render_timing(sections, [], multitrack=True, layer_duration=0)
        spans = plan_video_frames(sections, timing, [], 30, multitrack=True)
        self.assertEqual([(item.join_start, item.picture_start, item.end) for item in spans],
                         [(0, 8, 24), (24, 24, 35), (35, 35, 51)])

    def test_bounded_reverse_samples_keep_the_export_source_grid_origin(self):
        clock = ClipClock(.07, .55, 1.3, True)
        full = source_frame_samples(clock, 30, .15, 0, 20)
        window = source_frame_samples(clock, 30, .15, 6, 13, snapshot=True)
        self.assertEqual(full.origin, window.origin)
        self.assertEqual((full.first_source_tick, window.first_source_tick), (-20, -13))
        self.assertEqual((full.count, window.count, window.timeline_offset), (21, 8, .2))

    def test_zoom_receives_output_cadence_and_restores_each_snapshot_base(self):
        first = "trim=end=3,setpts=(PTS-STARTPTS)/2.00000000"
        zoom = ",zoompan=z=1:d=1:fps=24"
        self.assertEqual(normalize_zoom_cadence(first, 24), first)
        self.assertEqual(normalize_zoom_cadence(first + zoom * 2, 24), first + ",fps=24" + zoom * 2)
        self.assertEqual(
            normalize_zoom_cadence(first + zoom * 2, 24, snapshot_base=-.25),
            first + ",fps=24" + (zoom + ",setpts=PTS+-0.25000000/TB") * 2,
        )

    def test_audio_pads_to_video_span_after_speed_and_track_delays(self):
        timing = TimelineClip(ClipClock(2, 7, 2, True), .25, .75)
        trim = timing.source_trim(7.5)
        segment = {"channelMode": "right", "audioBalance": -25, "audioFadeIn": .1,
                   "audioFadeOut": .25, "trackMuted": True}
        self.assertEqual(clip_audio_filter("[0:a]", "[a0]", segment, timing, trim, mute=False),
                         "[0:a]atrim=start=2:end=7.5,areverse,asetpts=PTS-STARTPTS,atempo=2.00000000,"
                         "adelay=500:all=1,pan=stereo|c0=c1|c1=c1,pan=stereo|c0=1.00000*c0|c1=0.75000*c1,"
                         "afade=t=in:st=0.75000000:d=0.10000,afade=t=out:st=3.00000:d=0.25000,"
                         "volume=0.000000,adelay=250:all=1,aresample=48000,"
                         "apad=whole_dur=3.50000000,atrim=duration=3.50000000[a0]")
        self.assertEqual(clip_audio_filter(None, "[a0]", segment, timing, trim, mute=False),
                         "anullsrc=r=48000:cl=stereo,atrim=duration=3.50000000[a0]")

    def test_audio_joins_and_layer_mix_keep_base_timeline_duration(self):
        self.assertEqual(join_audio("[a]", "[b]", "[c]"), "[a][b]concat=n=2:v=0:a=1[c]")
        self.assertEqual(join_audio("[a]", "[b]", "[c]", overlap=".5"), "[a][b]acrossfade=d=.5:c1=tri:c2=tri[c]")
        self.assertEqual(mix_audio_layers("[a]", [], 4), ["[a]anull[outa]"])
        self.assertEqual(mix_audio_layers("[a]", [{"start": 1, "end": 2, "sourceStart": .25, "volume": .5}], 4), [
            "[4:a]atrim=start=0.25:duration=1,asetpts=PTS-STARTPTS,volume=0.5,adelay=1000:all=1[mediaa0]",
            "[a][mediaa0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=.95[outa]",
        ])


if __name__ == "__main__":
    unittest.main()
