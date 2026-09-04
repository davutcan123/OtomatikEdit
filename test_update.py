import urllib.request, json
try:
    req = urllib.request.Request("https://api.github.com/repos/davutcan123/OtomatikEdit/releases/latest")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        print("Remote tag:", data.get("tag_name"))
except Exception as e:
    print("Error:", e)
