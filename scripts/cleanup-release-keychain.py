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


def run(command, privileged=False):
    """Runs one cleanup command for at most 15 s; True when it finished without an error."""
    print("Cleaning " + command[-1], flush=True)
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if process.wait(timeout=15):
            print("::warning::Keychain cleanup returned an error; disposable runner teardown remains required.")
            return False
        return True
    except subprocess.TimeoutExpired:
        # Under sudo the command runs as root, beyond this user's signals: its group is killed through sudo too.
        if privileged:
            try:
                subprocess.run(["sudo", "-n", "kill", "-KILL", "--", f"-{process.pid}"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
            except subprocess.TimeoutExpired:
                pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            # Gone, or (EPERM on macOS) members only root can signal: the sudo kill above was the way to them.
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # Never a hang here: the certificate stays for the second cleanup, and the runner's teardown ends the rest.
            print("::warning::Keychain cleanup timed out and could not be stopped; disposable runner teardown remains required.")
            return False
        print("::warning::Keychain cleanup timed out; disposable runner teardown remains required.")
        return False


trust_removed = True
if cert.exists():
    trust_removed = run(["sudo", "-n", "security", "remove-trusted-cert", "-d", str(cert)], privileged=True)
if keychain.exists():
    run(["security", "delete-keychain", str(keychain)])
# The certificate names the trust to remove: kept while that failed, so the workflow's second cleanup retries it.
for name in ["recordstuff-signing.p12"] + (["recordstuff-signing.pem"] if trust_removed else []):
    (root / name).unlink(missing_ok=True)
