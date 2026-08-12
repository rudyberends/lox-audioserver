import fsp from 'node:fs/promises';
import { bestEffort, bestEffortSync } from '@/shared/bestEffort';
import { createLogger } from '@/shared/logging/logger';

/**
 * Why `mount -t cifs` was refused, when the refusal is about the container's own privileges rather
 * than about the share.
 *
 * `mount error(13): Permission denied` is the same message whether the password is wrong, the share
 * ACL says no, or the kernel never let the syscall through — so on its own it sends people hunting
 * through NAS user accounts for a problem that lives in their compose file (#323). Two things
 * decide whether the syscall can succeed at all, both readable from /proc, both verified against
 * the shipped image:
 *
 *   - CAP_SYS_ADMIN in the *effective* set. Without `cap_add` the mask is 0x…a80425fb (bit 21
 *     clear); with it, 0x…a82425ff. The bounding set is not enough — mount(2) checks the effective
 *     set, which is why "cap_add is right there in my compose file" and "the mount works" are
 *     different claims.
 *   - AppArmor. Docker's default `docker-default` profile denies mount(2) even when the capability
 *     is present, so the capability check passing tells you nothing on its own.
 *
 * A third case defeats both: in a user namespace that is not the host's (rootless Docker,
 * userns-remap) the capability is only ever namespace-local and the kernel refuses these mounts no
 * matter what is granted. That one has no in-container fix, so it has to be named as such instead
 * of sending someone off to add capabilities that cannot help.
 */

const log = createLogger('Content', 'Storage');

/** CAP_SYS_ADMIN is capability 21; mount(2) wants it in the effective set. */
export const CAP_SYS_ADMIN_BIT = 21n;
/** What /proc/self/uid_map reads as when the process is in the host's user namespace. */
const HOST_UID_MAP_COUNT = 4294967295;

export interface MountPrivileges {
  /** Effective capability mask, or null when /proc/self/status could not be read. */
  effectiveCaps: bigint | null;
  /** CAP_SYS_ADMIN present in the effective set; null when the mask is unknown. */
  hasSysAdmin: boolean | null;
  /** AppArmor label, e.g. "docker-default (enforce)" or "unconfined"; null when AppArmor is off. */
  apparmorProfile: string | null;
  /** An AppArmor profile is loaded and is not "unconfined", so mount(2) is subject to it. */
  apparmorConfined: boolean;
  /** The process sits in a user namespace other than the host's (rootless / userns-remap). */
  userNamespaced: boolean;
  /** Running inside a container, so the fix is a compose change rather than a service change. */
  containerized: boolean;
}

export interface MountDiagnosis {
  /** Stable machine-readable cause, for logs and for callers that want to branch. */
  code: 'user-namespace' | 'missing-sys-admin' | 'apparmor-confined';
  /** End-user-facing explanation: what is wrong, and the change that fixes it. */
  message: string;
}

async function readProcText(file: string): Promise<string | null> {
  return bestEffort(async () => (await fsp.readFile(file, 'utf8')).trim(), {
    fallback: null,
    onError: 'debug',
    log,
    label: 'proc read failed',
    context: { file },
  });
}

/** Exported for tests: the CapEff line is the whole basis of the capability half of the diagnosis. */
export function parseEffectiveCaps(status: string | null): bigint | null {
  if (!status) {
    return null;
  }
  const match = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(status);
  const hex = match?.[1];
  if (!hex) {
    return null;
  }
  return bestEffortSync<bigint | null>(() => BigInt(`0x${hex}`), {
    fallback: null,
    onError: 'debug',
    log,
    label: 'CapEff parse failed',
  });
}

/**
 * True when the first uid_map line is anything other than the host's identity mapping. Docker
 * writes `0 0 4294967295` for a normal container and a narrower range under userns-remap; rootless
 * Docker maps the invoking user instead. An unreadable map is treated as "not namespaced", so a
 * kernel without user namespaces never produces a misleading diagnosis.
 */
export function parseUserNamespaced(uidMap: string | null): boolean {
  if (!uidMap) {
    return false;
  }
  const first = uidMap.split('\n')[0]?.trim();
  if (!first) {
    return false;
  }
  const [inside, outside, count] = first.split(/\s+/).map((field) => Number(field));
  if (inside === undefined || outside === undefined || count === undefined) {
    return false;
  }
  if (!Number.isFinite(inside) || !Number.isFinite(outside) || !Number.isFinite(count)) {
    return false;
  }
  return !(inside === 0 && outside === 0 && count === HOST_UID_MAP_COUNT);
}

/**
 * Snapshot of the privileges that decide whether mount(2) can succeed here. Every read is
 * best-effort: a missing /proc entry has to leave the field unknown rather than invent a cause,
 * because a wrong diagnosis is worse than the raw kernel error it replaces.
 */
export async function readMountPrivileges(): Promise<MountPrivileges> {
  const [status, apparmorSpecific, apparmorGeneric, uidMap, containerized] = await Promise.all([
    readProcText('/proc/self/status'),
    // The AppArmor-specific path first: /proc/self/attr/current is the shared LSM interface and
    // reports the SELinux context on SELinux systems, which would read as a confining profile.
    readProcText('/proc/self/attr/apparmor/current'),
    readProcText('/proc/self/attr/current'),
    readProcText('/proc/self/uid_map'),
    isContainerized(),
  ]);

  const apparmorEnabled = (await readProcText('/sys/module/apparmor/parameters/enabled')) === 'Y';
  const apparmorProfile = apparmorSpecific ?? (apparmorEnabled ? apparmorGeneric : null);
  const effectiveCaps = parseEffectiveCaps(status);

  return {
    effectiveCaps,
    hasSysAdmin:
      effectiveCaps === null ? null : (effectiveCaps & (1n << CAP_SYS_ADMIN_BIT)) !== 0n,
    apparmorProfile,
    apparmorConfined: apparmorProfile !== null && !apparmorProfile.startsWith('unconfined'),
    userNamespaced: parseUserNamespaced(uidMap),
    containerized,
  };
}

/**
 * Whether we are inside a container, which decides what advice can even apply: running from a
 * package needs a different fix than editing a compose file, and telling someone to edit a compose
 * file they do not have is the same dead end #323 started from.
 */
async function isContainerized(): Promise<boolean> {
  const dockerEnv = await bestEffort(
    async () => {
      await fsp.access('/.dockerenv');
      return true;
    },
    { fallback: false },
  );
  if (dockerEnv) {
    return true;
  }
  const cgroup = await readProcText('/proc/1/cgroup');
  return cgroup !== null && /docker|kubepods|containerd|lxc/i.test(cgroup);
}

/** A mount(2) refusal that is about permission, as opposed to a wrong host, share or charset. */
export function isPermissionDenied(message: string): boolean {
  return /mount error\(13\)|permission denied|\bEACCES\b/i.test(message);
}

/**
 * Turn a privilege snapshot into the one thing the user should change, or null when the privileges
 * look fine and the refusal really is about the share or the credentials.
 *
 * Order matters: the cases can co-occur, and only the most fundamental one is worth acting on. No
 * amount of `cap_add` helps inside a foreign user namespace, so that is reported first.
 */
export function diagnoseMountPermissions(privileges: MountPrivileges): MountDiagnosis | null {
  if (privileges.userNamespaced) {
    return {
      code: 'user-namespace',
      message:
        'This container cannot mount network shares itself: it runs with remapped user IDs ' +
        '(rootless Docker, or userns-remap), and the system does not allow mounting from there — ' +
        'no amount of extra permissions changes that. Mount the share on the host instead and ' +
        'pass the folder in, for example `- /mnt/music:/app/data/music/nas/mynas:ro` under ' +
        '`volumes:`. sonn then just reads the folder.',
    };
  }

  if (privileges.hasSysAdmin === false) {
    return {
      code: 'missing-sys-admin',
      message: privileges.containerized
        ? 'This container is not allowed to mount network shares. Add these two lines to the ' +
          'service in your docker-compose.yml and recreate the container — restarting is not ' +
          'enough, because these only take effect when the container is created:\n' +
          '  cap_add: [SYS_ADMIN, DAC_READ_SEARCH]\n' +
          '  security_opt: ["apparmor:unconfined"]\n' +
          'Alternatively, mount the share on the host and pass the folder in as a volume.'
        : 'sonn is not running with permission to mount network shares. Mounting requires root, ' +
          'so either run the service as root, or mount the share yourself (in /etc/fstab, for ' +
          'example) and add it as a local folder instead of a network share.',
    };
  }

  if (privileges.apparmorConfined) {
    // The case #323 actually hit: the capability was granted, so everything looked right, and the
    // security profile was the silent half.
    const cause =
      'Permission to mount network shares is granted, but the system\'s security profile ' +
      `(${privileges.apparmorProfile}) blocks mounting anyway.`;
    return {
      code: 'apparmor-confined',
      message: privileges.containerized
        ? `${cause} Add this line to the service in your docker-compose.yml, next to the existing ` +
          'cap_add, and recreate the container:\n  security_opt: ["apparmor:unconfined"]'
        : `${cause} Allow mounting for sonn in that profile, or mount the share yourself and add ` +
          'it as a local folder instead of a network share.',
    };
  }

  return null;
}

/** What to say when the privileges are fine, so the share itself is the remaining suspect. */
const SHARE_HINT =
  'The server is allowed to mount shares, so this is most likely the share itself: check the ' +
  'username and password, and that this share allows that user.';

/**
 * Assemble the final message: guidance first, kernel wording second.
 *
 * The order is the point. `mount.cifs failed: Command failed: mount -t cifs //… mount error(13)`
 * is the least useful sentence for the person reading it, and putting it first buries the one line
 * that says what to change under something that looks like the real answer. The raw text still has
 * to be there — it is what makes a bug report diagnosable — so it stays, labelled as detail.
 */
export function composeMountMessage(reason: string, diagnosis: MountDiagnosis | null): string {
  return `${diagnosis?.message ?? SHARE_HINT}\n\nTechnical detail — mount.cifs failed: ${reason}`;
}

/**
 * The message to show for a failed mount: what to change when the host's or container's privileges
 * are what stopped it, and the kernel's own words underneath. Anything that is not a permission
 * refusal is passed through untouched — a wrong password should not be answered with compose advice,
 * and #321's charset failure has its own explanation already.
 */
export async function explainMountFailure(reason: string): Promise<string> {
  if (!isPermissionDenied(reason)) {
    return `mount.cifs failed: ${reason}`;
  }

  const privileges = await readMountPrivileges();
  const diagnosis = diagnoseMountPermissions(privileges);
  log.debug('mount permission snapshot', {
    caps: privileges.effectiveCaps === null ? null : privileges.effectiveCaps.toString(16),
    hasSysAdmin: privileges.hasSysAdmin,
    apparmor: privileges.apparmorProfile,
    userNamespaced: privileges.userNamespaced,
    containerized: privileges.containerized,
    diagnosis: diagnosis?.code ?? null,
  });

  return composeMountMessage(reason, diagnosis);
}
