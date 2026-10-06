/** The recording shortcut's editor: arming, typing a combination, confirming it and its refusals. */
import type { SettingsGroup } from "../../../shared/settings-panel";
import { SETTINGS_SHORTCUT_RESERVED, isSettingsShortcut, validateAccelerator } from "../../../shared/hotkey";
import { shortcutCandidate, shortcutModifiers, isCloseChord } from "../../lib/shortcut-capture";
import { sentences, translate } from "../../../shared/i18n";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import * as model from "../settings-controller";

export function ShortcutEditor({ group }: { group: SettingsGroup }) {
  const id = `setting-${group.id}`;
  const keydown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!group.capturing) return;
    const p = model.platform();
    if (isCloseChord(event.nativeEvent, p)) return;
    if (
      event.key === "Tab" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      if (!model.candidateToConfirm) {
        void model.capture(false);
        const cancel = document.getElementById("shortcut-cancel");
        if (cancel) cancel.tabIndex = -1;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (model.saving || event.repeat) return;
    if (event.key === "Escape") {
      void model.capture(false, true);
      return;
    }
    if (
      model.candidateToConfirm &&
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      void model.choose(group.id, model.candidateToConfirm, "shortcut-capture");
      return;
    }
    const candidate = shortcutCandidate(event.nativeEvent, p);
    if (candidate === undefined && model.candidateToConfirm) return;
    model.setCandidate(undefined);
    model.setPreview(
      candidate ?? shortcutModifiers(event.nativeEvent, p).join("+"),
      p,
    );
    if (candidate === undefined) {
      model.draw();
      return;
    }
    const result = validateAccelerator(candidate, p);
    const error =
      result.error ??
      (isSettingsShortcut(result.accelerator, p)
        ? SETTINGS_SHORTCUT_RESERVED
        : undefined);
    if (error) {
      model.setPreview(shortcutModifiers(event.nativeEvent, p).join("+"), p);
      const message = translate(error, model.view?.language);
      model.setFailure({
        group: group.id,
        text: message,
        refused: true,
        editor: true,
      });
      model.announce(message);
      return;
    }
    model.setCandidate(result.accelerator);
    model.setFailure(undefined);
    model.announce(
      sentences(
        [model.preview, model.text("Confirm to save")],
        model.view?.language,
      ),
    );
  };
  const display = model.preview || model.text("Press a combination");
  return (
    <>
      <div
        className="capture-area"
        hidden={!group.capturing}
        onBlur={(event) => {
          const area = event.currentTarget,
            next = event.relatedTarget;
          queueMicrotask(() => {
            if (
              model.shortcutGroup()?.capturing &&
              !model.saving &&
              !area.contains(next ?? document.activeElement)
            )
              void model.capture(false);
          });
        }}
      >
        <Button
          variant="outline"
          id="shortcut-capture"
          disabled={!group.enabled}
          onKeyDown={keydown}
          aria-describedby={group.capturing ? `${id}-help` : undefined}
          aria-label={sentences(
            [display, model.text("Escape to cancel")],
            model.view?.language,
          )}
          onKeyUp={(event) => {
            if (
              group.capturing &&
              !model.saving &&
              !model.candidateToConfirm &&
              ["Meta", "Control", "Alt", "Shift"].includes(event.key)
            ) {
              model.setPreview(
                shortcutModifiers(event.nativeEvent, model.platform()).join(
                  "+",
                ),
                model.platform(),
              );
              model.draw();
            }
          }}
        >
          <span className="listening-indicator" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {model.preview
            ? model.previewParts.map((key) => <Kbd key={key}>{key}</Kbd>)
            : display}
        </Button>
        <Button
          id="shortcut-confirm"
          disabled={!group.enabled || !model.candidateToConfirm}
          aria-disabled={
            Boolean(model.saving) || !group.enabled || !model.candidateToConfirm
          }
          tabIndex={model.candidateToConfirm ? 0 : -1}
          onMouseDown={(event) => {
            if (event.button === 0) event.preventDefault();
          }}
          onClick={() => {
            if (
              model.candidateToConfirm &&
              model.shortcutGroup()?.capturing &&
              !model.saving
            )
              void model.choose(
                group.id,
                model.candidateToConfirm,
                "shortcut-confirm",
              );
          }}
        >
          {model.text("Confirm")}
        </Button>
        <Button
          variant="outline"
          id="shortcut-cancel"
          disabled={Boolean(model.saving)}
          onClick={() => void model.capture(false, true)}
        >
          {model.text("Cancel")}
        </Button>
        <p id={`${id}-help`} className="capture-help" hidden={!group.capturing}>
          {model.captureText(
            "Press a combination and Confirm within {seconds} seconds; Esc cancels",
          )}
        </p>
      </div>
      <p
        id={`${id}-timeout`}
        className="capture-timeout"
        hidden={!group.captureTimedOut}
      >
        {group.captureTimedOut
          ? model.captureText(
              "Timed out after {seconds} seconds; the shortcut is unchanged. Choose Custom shortcut… to try again.",
            )
          : ""}
      </p>
    </>
  );
}
