import json, traceback
try:
    from faster_whisper import WhisperModel
    m = WhisperModel("small", device="cpu", compute_type="int8")
    for line in open("voz/transcribe.txt"):
        f = line.strip()
        if not f: continue
        segs, info = m.transcribe("voz/" + f, language="pt", word_timestamps=True)
        words = []
        for s in segs:
            for w in s.words:
                words.append({"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3)})
        json.dump(words, open("voz/" + f + ".json", "w"), ensure_ascii=False)
    open("voz/log.txt","w").write("ok")
except Exception:
    open("voz/log.txt","w").write(traceback.format_exc())
