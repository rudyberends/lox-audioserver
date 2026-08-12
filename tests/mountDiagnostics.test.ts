import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  CAP_SYS_ADMIN_BIT,
  composeMountMessage,
  diagnoseMountPermissions,
  isPermissionDenied,
  parseEffectiveCaps,
  parseUserNamespaced,
  type MountPrivileges,
} from '../src/adapters/content/storage/mountDiagnostics';

// `mount error(13): Permission denied` is the same sentence whether the password is wrong or the
// kernel never let the syscall through, which is what sent #323 hunting through NAS user accounts
// for a problem that lived in a compose file. These are the two /proc signals that tell those apart,
// with the masks below read off the shipped 4.0.0-beta.18 image.

const privileges = (over: Partial<MountPrivileges> = {}): MountPrivileges => ({
  effectiveCaps: 0n,
  hasSysAdmin: true,
  apparmorProfile: null,
  apparmorConfined: false,
  userNamespaced: false,
  containerized: true,
  ...over,
});

test('the measured capability masks decide the SYS_ADMIN question', () => {
  // Straight off the image: without cap_add, and with `--cap-add SYS_ADMIN DAC_READ_SEARCH`.
  const withoutCapAdd = parseEffectiveCaps('Name:\tnode\nCapEff:\t00000000a80425fb\nSeccomp:\t2');
  const withCapAdd = parseEffectiveCaps('Name:\tnode\nCapEff:\t00000000a82425ff\nSeccomp:\t2');
  assert.equal(withoutCapAdd !== null && (withoutCapAdd & (1n << CAP_SYS_ADMIN_BIT)) !== 0n, false);
  assert.equal(withCapAdd !== null && (withCapAdd & (1n << CAP_SYS_ADMIN_BIT)) !== 0n, true);
});

test('an unreadable capability mask stays unknown rather than becoming a cause', () => {
  // A wrong diagnosis is worse than the raw kernel error it replaces, so no CapEff line means the
  // capability case must not fire — the AppArmor case can still speak for itself.
  assert.equal(parseEffectiveCaps(null), null);
  assert.equal(parseEffectiveCaps('Name:\tnode\nSeccomp:\t2'), null);
  assert.equal(diagnoseMountPermissions(privileges({ hasSysAdmin: null })), null);
});

test('only the host identity mapping counts as not namespaced', () => {
  // What Docker writes for an ordinary container; anything narrower is userns-remap or rootless.
  assert.equal(parseUserNamespaced('         0          0 4294967295'), false);
  assert.equal(parseUserNamespaced('         0     100000      65536'), true);
  assert.equal(parseUserNamespaced('         0       1000          1'), true);
  // A kernel without user namespaces must not read as namespaced.
  assert.equal(parseUserNamespaced(null), false);
  assert.equal(parseUserNamespaced(''), false);
});

test('a foreign user namespace outranks every grantable permission', () => {
  // Both other causes are present here too, but cap_add and security_opt cannot help inside a
  // remapped namespace — advising them would send someone editing compose for nothing.
  const diagnosis = diagnoseMountPermissions(
    privileges({
      userNamespaced: true,
      hasSysAdmin: false,
      apparmorProfile: 'docker-default (enforce)',
      apparmorConfined: true,
    }),
  );
  assert.equal(diagnosis?.code, 'user-namespace');
  assert.match(String(diagnosis?.message), /volumes:/);
});

test('the capability comes before the profile that would also have blocked it', () => {
  const diagnosis = diagnoseMountPermissions(
    privileges({
      hasSysAdmin: false,
      apparmorProfile: 'docker-default (enforce)',
      apparmorConfined: true,
    }),
  );
  assert.equal(diagnosis?.code, 'missing-sys-admin');
  // Both lines, because granting only the capability reproduces the very next failure.
  assert.match(String(diagnosis?.message), /cap_add/);
  assert.match(String(diagnosis?.message), /security_opt/);
});

test('the default Docker profile is named as the cause once the capability is there', () => {
  // Measured: with SYS_ADMIN granted, mount(2) still fails under `docker-default (enforce)` and
  // succeeds under `unconfined`. So having the capability proves nothing on its own.
  const diagnosis = diagnoseMountPermissions(
    privileges({ apparmorProfile: 'docker-default (enforce)', apparmorConfined: true }),
  );
  assert.equal(diagnosis?.code, 'apparmor-confined');
  assert.match(String(diagnosis?.message), /docker-default/);
});

test('an install without Docker is not told to edit a compose file', () => {
  // Running from a package is supported, and there the compose advice is a dead end of its own.
  const bare = diagnoseMountPermissions(privileges({ hasSysAdmin: false, containerized: false }));
  assert.equal(bare?.code, 'missing-sys-admin');
  assert.equal(/docker-compose|cap_add/.test(String(bare?.message)), false);
  assert.match(String(bare?.message), /root/);

  const confined = diagnoseMountPermissions(
    privileges({ apparmorProfile: 'sonn-core (enforce)', apparmorConfined: true, containerized: false }),
  );
  assert.equal(confined?.code, 'apparmor-confined');
  assert.equal(/docker-compose|security_opt/.test(String(confined?.message)), false);
});

test('privileges that are actually fine produce no compose advice', () => {
  // Then it really is the share or the credentials, and pointing at the container would mislead.
  assert.equal(diagnoseMountPermissions(privileges()), null);
  assert.equal(
    diagnoseMountPermissions(privileges({ apparmorProfile: 'unconfined' })),
    null,
  );
});

test('the fix is read before the kernel wording, not after it', () => {
  // Leading with `Command failed: mount -t cifs //… mount error(13)` buries the one line that says
  // what to change under something that looks like the answer.
  const reason = 'Command failed: mount -t cifs //nas/Music /mnt\nmount error(13): Permission denied';
  const diagnosis = diagnoseMountPermissions(privileges({ hasSysAdmin: false }));
  const message = composeMountMessage(reason, diagnosis);
  assert.ok(message.startsWith('This container is not allowed'), message.slice(0, 40));
  assert.ok(message.indexOf('cap_add') < message.indexOf('mount error(13)'));
  // The raw text still has to survive: it is what makes a bug report diagnosable, and the Loxone
  // side maps `permission denied` out of this same string.
  assert.match(message, /mount error\(13\): Permission denied/);
  assert.match(composeMountMessage(reason, null), /^The server is allowed to mount shares/);
});

test('only permission refusals are treated as privilege problems', () => {
  assert.equal(isPermissionDenied('mount error(13): Permission denied'), true);
  assert.equal(isPermissionDenied('mount: EACCES while mounting //nas/Music'), true);
  // #321's charset failure and a plain wrong hostname must keep their own message untouched.
  assert.equal(isPermissionDenied('mount error(79): iocharset utf8 not found'), false);
  assert.equal(isPermissionDenied('Unable to find suitable address.'), false);
});
