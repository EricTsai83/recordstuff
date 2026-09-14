"""Bounded cleanup for disposable GitHub-hosted macOS release runners only."""
import os
from pathlib import Path
import signal
import subprocess

if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise SystemExit("Cleanup is restricted to disposable GitHub-hosted runners.")
root = Path(os.environ["RUNNER_TEMP"])
cert = root / "recordstuff-signing.pem"
keychain = root / "recordstuff-signing.keychain-db"
commands = []
if cert.exists():
    commands.append(["sudo", "-n", "security", "remove-trusted-cert", "-d", str(cert)])
if keychain.exists():
    commands.append(["security", "delete-keychain", str(keychain)])
for command in commands:
    print("Cleaning " + command[-1], flush=True)
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        code = process.wait(timeout=15)
        if code:
            print("::warning::Keychain cleanup returned an error; disposable runner teardown remains required.")
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        print("::warning::Keychain cleanup timed out; disposable runner teardown remains required.")
for name in ["recordstuff-signing.pem", "recordstuff-signing.p12"]:
    (root / name).unlink(missing_ok=True)
