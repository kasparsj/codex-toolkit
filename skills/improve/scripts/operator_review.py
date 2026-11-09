"""Review one Improve decision in the operator's terminal."""

import json
import sys


def main():
    packet = json.load(sys.stdin)
    phase = packet["phase"]
    dispositions = ("clear", "defer", "duplicate", "covered", "fixed") if phase == "overlap" else ("clear", "defer")
    with open("/dev/tty", "r") as replies, open("/dev/tty", "w", buffering=1) as terminal:
        terminal.write("\nImprove review\n" + json.dumps(packet, ensure_ascii=True, indent=2) + "\n")
        terminal.write(f"Disposition ({'/'.join(dispositions)}, Enter defers)\n")
        terminal.flush()
        disposition = replies.readline().strip()
        if disposition not in dispositions:
            disposition = "defer"
        related = []
        related_candidate = None
        if phase == "overlap" and disposition != "defer":
            terminal.write("Related issue or PR numbers, or one candidate ID for an in-batch duplicate\n")
            terminal.flush()
            links = replies.readline().split()
            if disposition == "duplicate" and len(links) == 1 and links[0].startswith("F"):
                related_candidate = links[0]
            else:
                related = [int(number) for number in links]
        terminal.write("Safe explanation for the audit report\n")
        terminal.flush()
        reason = replies.readline().strip() or "Operator deferred or reviewed this phase."
    response = {
        "digest": packet["digest"],
        "disposition": disposition,
        "related": related,
        "reason": reason,
    }
    if related_candidate:
        response["related_candidate"] = related_candidate
    json.dump(response, sys.stdout)


if __name__ == "__main__":
    main()
