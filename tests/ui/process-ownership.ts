/** Track identities across snapshots: Windows can reuse a PID while a dead parent's children retain it. */
export class ProcessOwnership {
  private readonly known = new Map<number, { created?: bigint; command: string }>();
  constructor(private readonly root: number, private readonly marker: string, private readonly executable: string, private readonly self: number) {}

  read(table: string): Array<{ pid: number; command: string }> {
    const rows = new Map<number, { pid: number; parent: number; created?: bigint; command: string }>();
    for (const line of table.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s?(?:@(\d+)\s?)?(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      rows.set(pid, { pid, parent: Number(match[2]), ...(match[3] ? { created: BigInt(match[3]) } : {}), command: match[4]! });
    }
    const same = (a: { created?: bigint; command: string }, b: { created?: bigint; command: string }): boolean =>
      a.created !== undefined || b.created !== undefined ? a.created === b.created : a.command === b.command;
    const runsElectron = (command: string): boolean => {
      const unquoted = command.replace(/^"/, "").toLowerCase(), executable = this.executable.toLowerCase();
      return unquoted.startsWith(executable) && /^(?:"?\s|$)/.test(unquoted.slice(executable.length));
    };
    const owned = new Set<number>();
    for (const row of rows.values()) {
      if (row.pid === this.self) continue;
      const prior = this.known.get(row.pid);
      if (prior ? same(prior, row) : runsElectron(row.command) && (row.pid === this.root || row.command.includes(this.marker))) owned.add(row.pid);
    }
    // An absent parent can still have surviving children, but only with a previously observed identity.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        if (owned.has(row.pid) || row.pid === this.self) continue;
        const parent = rows.get(row.parent), previousParent = this.known.get(row.parent);
        const identity = owned.has(row.parent) ? parent : !parent ? previousParent : undefined;
        if (!identity || (identity.created !== undefined && (row.created === undefined || row.created < identity.created))) continue;
        const prior = this.known.get(row.pid);
        if (prior && !same(prior, row)) continue;
        owned.add(row.pid); changed = true;
      }
    }
    return [...owned].map(pid => {
      const row = rows.get(pid)!;
      this.known.set(pid, row);
      return { pid, command: row.command };
    });
  }
}
