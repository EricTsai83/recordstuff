/**
 * `node scripts/ui-group.mts <group>`: prints the background specs of one CI group (scripts/lib/runner/ui-groups.mts),
 * space-separated, for `pnpm test:ui $(…)`. Exit 2 for an unknown group.
 */
import { UI_GROUPS, isUiGroup } from "./lib/runner/ui-groups.mts";
import { runnerArgs } from "./lib/runner/runner-env.mts";

const [name] = runnerArgs();
if (!name || !isUiGroup(name)) {
  console.error(`Usage: node scripts/ui-group.mts <${Object.keys(UI_GROUPS).join("|")}>`);
  process.exit(2);
}
console.log(UI_GROUPS[name].join(" "));
