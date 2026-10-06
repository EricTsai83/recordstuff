/** Draft ownership and file-name validation, independent of the field's presentation. */
import { useLayoutEffect, useRef, useState } from "react";
import type { SettingsGroup } from "../../shared/settings-panel";
import { translate } from "../../shared/i18n";
import {
  fileNameTemplateProblem,
  fileNameProblemText,
  formatFileName,
} from "../../shared/file-name";
import * as model from "./settings-controller";

export function useTextSetting(group: SettingsGroup) {
  const value = model.committed(group),
    held = Boolean(
      group.enabled && model.saving && model.saving.group !== group.id,
    ),
    [draft, setDraft] = useState(value),
    // The example's time is read once, when the field appears: redrawn with the clock it changed under the reader's
    // eyes on every update of the page (2026-10-07).
    [sampleTime] = useState(() => new Date()),
    field = useRef<HTMLInputElement>(null),
    submitted = useRef<string | undefined>(undefined),
    lastCommitted = useRef(value);
  useLayoutEffect(() => {
    if (lastCommitted.current !== value) {
      lastCommitted.current = value;
      if (draft.trim() === value || document.activeElement !== field.current)
        setDraft(value);
    }
  }, [value, draft]);
  const submit = (): void => {
    const name = (field.current?.value ?? draft).trim();
    if (
      !group.enabled ||
      name === model.committed(group) ||
      name === submitted.current
    )
      return;
    submitted.current = name;
    void model.choose(group.id, name, `setting-${group.id}`).finally(() => {
      submitted.current = undefined;
    });
  };
  const problem = fileNameTemplateProblem(draft.trim()),
    refused = Boolean(problem) && draft.trim() !== value;
  const note =
    draft.trim() === value
      ? (group.note ?? "")
      : problem
        ? fileNameProblemText(problem, model.view?.language ?? "en")
        : translate("Example: {name}", model.view?.language, {
            name: `${formatFileName(draft.trim(), sampleTime)}.mp4`,
          });
  const edit = (next: string) => {
    model.clearFailure(group.id);
    setDraft(next);
  };
  const reset = () => {
    setDraft(value);
    model.clearFailure(group.id);
  };
  return { value, held, draft, field, submit, refused, note, edit, reset };
}
