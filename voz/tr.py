import json, traceback
try:
    from faster_whisper import WhisperModel
    m = WhisperModel("small", device="cpu", compute_type="int8")
    for line in open("voz/transcribe.txt"):
        parts = line.split()
        if not parts: continue
        f = parts[0]; lang = parts[1] if len(parts) > 1 else "pt"
        segs, info = m.transcribe("voz/" + f, language=lang, word_timestamps=True)
        words = []
        for s in segs:
            for w in s.words:
                words.append({"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3)})
        json.dump(words, open("voz/" + f + ".json", "w"), ensure_ascii=False)
    open("voz/log.txt","w").write("ok")
except Exception:
    open("voz/log.txt","w").write(traceback.format_exc())
