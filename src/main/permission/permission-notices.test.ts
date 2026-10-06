import { expect, it, vi } from "vitest";
import { PermissionNotices } from "./permission-notices";

function setup() {
  const permission = vi.fn(), failure = vi.fn();
  return { permission, failure, notices: new PermissionNotices({ permission, failure }) };
}

it("notifies a capture refusal once even when cleanup delays the permission transition", () => {
  const { notices, permission, failure } = setup();
  notices.stateChanged({ type: "starting" });
  notices.stateChanged({ type: "idle" });
  notices.failed("permission_denied");
  notices.stateChanged({ type: "needsPermission", needsRelaunch: true });
  notices.stateChanged({ type: "needsPermission", needsRelaunch: true });
  expect(failure).toHaveBeenCalledExactlyOnceWith("permission_denied");
  expect(permission).not.toHaveBeenCalled();
  // Recovery resets the episode; a future revocation must still be reported.
  notices.stateChanged({ type: "idle" });
  notices.stateChanged({ type: "needsPermission", needsRelaunch: false });
  expect(permission).toHaveBeenCalledExactlyOnceWith(false);
});

it("keeps the permission notice when revocation settles before the failure result", () => {
  const { notices, permission, failure } = setup();
  notices.stateChanged({ type: "needsPermission", needsRelaunch: false });
  notices.failed("permission_denied");
  expect(permission).toHaveBeenCalledExactlyOnceWith(false);
  expect(failure).not.toHaveBeenCalled();
  // A later grant that needs a restart remains useful new guidance.
  notices.stateChanged({ type: "needsPermission", needsRelaunch: true });
  expect(permission.mock.calls).toEqual([[false], [true]]);
  notices.failed("disk_full");
  expect(failure).toHaveBeenCalledExactlyOnceWith("disk_full");
});

it("does not lose a refusal without a permission watcher or suppress the next attempt", () => {
  const { notices, permission, failure } = setup();
  notices.failed("permission_denied");
  expect(failure).toHaveBeenCalledOnce();
  notices.stateChanged({ type: "starting" });
  notices.stateChanged({ type: "needsPermission", needsRelaunch: true });
  expect(permission).toHaveBeenCalledExactlyOnceWith(true);
});
