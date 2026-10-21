/**
 * A typed setting such as the file name pattern: saved on Enter or when the field is left, with its example and
 * error under it.
 */
import type { SettingsGroup } from "../../../../shared/settings-panel";
import { Input } from "../../../components/ui/input";
import { FieldDescription } from "../../../components/ui/field";
import { useTextSetting } from "../../use-text-setting";
import { flushSync } from "react-dom";

export function TextSetting({
  group,
  description,
}: {
  group: SettingsGroup;
  description: string;
}) {
  const { value, draft, field, submit, refused, note, edit, reset } = useTextSetting(group);
  return (
    <>
      <Input
        ref={field}
        id={`setting-${group.id}`}
        className="text-field"
        value={draft}
        disabled={!group.enabled}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-describedby={description || undefined}
        aria-invalid={refused || undefined}
        onInput={(event) => {
          const draft = event.currentTarget.value;
          flushSync(() => edit(draft));
        }}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (
            event.key === "Escape" &&
            (field.current?.value ?? draft) !== value
          ) {
            event.preventDefault();
            event.stopPropagation();
            reset();
          }
        }}
      />
      <FieldDescription
        variant="note"
        className={`note text-note${refused ? " text-note-error" : ""}`}
        id={`setting-${group.id}-note`}
        hidden={!note}
      >
        {note}
      </FieldDescription>
    </>
  );
}
