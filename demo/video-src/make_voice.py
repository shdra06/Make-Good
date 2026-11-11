"""Makes one voice-over clip per narration line, then measures each.

    python demo/video-src/make_voice.py

Writes demo/video/voice/<id>.mp3 and demo/video/voice/durations.json.
Uses Microsoft's neural voices through the edge-tts package (needs internet).
Only the narration text in narration.json is sent.
"""
import asyncio, json, os, subprocess, sys

import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "video", "voice")
VOICE = os.environ.get("VOICE", "en-US-AndrewMultilingualNeural")
RATE = os.environ.get("RATE", "+6%")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


def duration(path):
    out = subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    return round(float(out.strip()), 3)


async def main():
    os.makedirs(OUT, exist_ok=True)
    lines = json.load(open(os.path.join(HERE, "narration.json"), encoding="utf-8"))
    durations = {}
    for line in lines:
        path = os.path.join(OUT, line["id"] + ".mp3")
        # About 2.6 words a second; a clip far shorter than that was cut off by the service.
        shortest = len(line["text"].split()) / 4.0
        for attempt in range(4):
            try:
                await edge_tts.Communicate(line["text"], VOICE, rate=RATE).save(path)
                if duration(path) >= shortest:
                    break
                print("clip cut short, retrying", line["id"])
            except Exception as e:  # the service drops now and then
                print("retry", line["id"], e)
        else:
            sys.exit(f"could not make a full clip for {line['id']}")
        durations[line["id"]] = duration(path)
        print(f"{line['id']:10s} {durations[line['id']]:6.2f}s")
    json.dump(durations, open(os.path.join(OUT, "durations.json"), "w"), indent=1)
    print(f"total {sum(durations.values()):.1f}s")


asyncio.run(main())
