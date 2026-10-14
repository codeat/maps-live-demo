#!/usr/bin/env python3
"""生成三段场景中文 TTS,输出 16kHz 单声道 raw PCM(int16 LE)到 server/static/audio/。
凭据走 ADC(自身 token),不落任何固定文件。"""
import base64
import json
import os
import subprocess
import urllib.request

PROJECT = os.environ.get("GCP_PROJECT_ID", "your-gcp-project-id")
OUT = os.path.join(os.path.dirname(__file__), "server", "static", "audio")
os.makedirs(OUT, exist_ok=True)

SCENES = {
    "s1.pcm": "帮我找乌节路附近一家评价高的精品咖啡店，然后带我导航过去。",
    "s2.pcm": "乌节路附近有没有环境安静的书店或阅读空间？带我导航过去。",
    "s3.pcm": "附近有没有地道好吃的肉骨茶或评价高的火锅？帮我开启导航。",
    "s4.pcm": "我想去滨海湾金沙或者鱼尾狮公园看夜景，帮我规划路线并开始导航。",
    "s5.pcm": "推荐一家乌节路附近地道正宗的海南鸡饭名店，然后帮我导航过去。",
    "s6.pcm": "附近有没有适合散步打卡的城市绿洲或热带公园？带我过去。",
}
VOICE = {"languageCode": "cmn-CN", "name": "cmn-CN-Wavenet-A"}


def token():
    return subprocess.check_output(
        ["gcloud", "auth", "application-default", "print-access-token"],
        text=True).strip()


def synth(tok, text):
    body = json.dumps({
        "input": {"text": text},
        "voice": VOICE,
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 16000,
                        "speakingRate": 1.0},
    }).encode()
    req = urllib.request.Request(
        "https://texttospeech.googleapis.com/v1/text:synthesize",
        data=body, method="POST",
        headers={"Authorization": "Bearer " + tok,
                 "x-goog-user-project": PROJECT,
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        wav = base64.b64decode(json.loads(r.read())["audioContent"])
    # 剥 WAV 头:定位 "data" chunk
    idx = wav.find(b"data")
    pcm = wav[idx + 8:] if idx >= 0 else wav[44:]
    return pcm


def main():
    tok = token()
    for fn, text in SCENES.items():
        pcm = synth(tok, text)
        with open(os.path.join(OUT, fn), "wb") as f:
            f.write(pcm)
        print("%s  %d bytes  (%.1fs)" % (fn, len(pcm), len(pcm) / 2 / 16000))


if __name__ == "__main__":
    main()
