import { WANTED_LOCKFILE } from '@pnpm/constants';
import { PnpmError } from '@pnpm/error';
import { ProjectSnapshot, type Lockfile } from '@pnpm/lockfile-types';
import { DEPENDENCIES_FIELDS } from '@pnpm/types';
import comverToSemver from 'comver-to-semver';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import semver from 'semver';
import { logger } from '../../../utils/logger';
import { LockfileBreakingChangeError } from './LockfileBreakingChangeError';
import { autofixMergeConflicts, isDiff } from './gitMergeFile';
import { revertFromInlineSpecifiersFormatIfNecessary } from './inlineSpecifiersLockfileConverters';

export type LockfileFile = Omit<Lockfile, 'importers'> &
    Partial<ProjectSnapshot> &
    Partial<Pick<Lockfile, 'importers'>>;

export function readWantedLockfile(
    pkgPath: string,
    opts: {
        wantedVersions?: string[];
        ignoreIncompatible: boolean;
        useGitBranchLockfile?: boolean;
        mergeGitBranchLockfiles?: boolean;
    }
): Lockfile | null {
    return _readWantedLockfile(pkgPath, opts).lockfile;
}

function _read(
    lockfilePath: string,
    prefix: string, // only for logging
    opts: {
        autofixMergeConflicts?: boolean;
        wantedVersions?: string[];
        ignoreIncompatible: boolean;
    }
): {
    lockfile: Lockfile | null;
    hadConflicts: boolean;
} {
    let lockfileRawContent;
    try {
        lockfileRawContent = require('strip-bom').default(fs.readFileSync(lockfilePath, 'utf8'));
    } catch (err: any) {
        // eslint-disable-line
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
        return {
            lockfile: null,
            hadConflicts: false
        };
    }
    let lockfile: Lockfile;
    let hadConflicts!: boolean;
    try {
        lockfile = revertFromInlineSpecifiersFormatIfNecessary(
            convertFromLockfileFileMutable(yaml.load(lockfileRawContent) as Lockfile)
        );
        hadConflicts = false;
    } catch (err: any) {
        // eslint-disable-line
        if (!opts.autofixMergeConflicts || !isDiff(lockfileRawContent)) {
            throw new PnpmError(
                'BROKEN_LOCKFILE',
                `The lockfile at "${lockfilePath}" is broken: ${err.message as string}`
            );
        }
        hadConflicts = true;
        lockfile = convertFromLockfileFileMutable(autofixMergeConflicts(lockfileRawContent));
        logger.info(`Merge conflict detected in ${WANTED_LOCKFILE} and successfully merged`, prefix);
    }
    if (lockfile) {
        const lockfileSemver = comverToSemver((lockfile.lockfileVersion ?? 0).toString());
        /* eslint-enable @typescript-eslint/dot-notation */
        if (
            !opts.wantedVersions ||
            opts.wantedVersions.length === 0 ||
            opts.wantedVersions.some((wantedVersion) => {
                if (semver.major(lockfileSemver) !== semver.major(comverToSemver(wantedVersion))) {
                    return false;
                }
                if (lockfile.lockfileVersion !== '6.1' && semver.gt(lockfileSemver, comverToSemver(wantedVersion))) {
                    logger.warn(
                        `Your ${WANTED_LOCKFILE} was generated by a newer version of pnpm. ` +
                            `It is a compatible version but it might get downgraded to version ${wantedVersion}`,
                        prefix
                    );
                }
                return true;
            })
        ) {
            return { lockfile, hadConflicts };
        }
    }
    if (opts.ignoreIncompatible) {
        logger.warn(`Ignoring not compatible lockfile at ${lockfilePath}`, prefix);
        return { lockfile: null, hadConflicts: false };
    }
    throw new LockfileBreakingChangeError(lockfilePath);
}

function _readWantedLockfile(
    pkgPath: string,
    opts: {
        wantedVersions?: string[];
        ignoreIncompatible: boolean;
    }
): {
    lockfile: Lockfile | null;
    hadConflicts: boolean;
} {
    const lockfileNames: string[] = [WANTED_LOCKFILE];
    let result: { lockfile: Lockfile | null; hadConflicts: boolean } = { lockfile: null, hadConflicts: false };
    /* eslint-disable no-await-in-loop */
    for (const lockfileName of lockfileNames) {
        result = _read(path.join(pkgPath, lockfileName), pkgPath, { ...opts, autofixMergeConflicts: true });
        if (result.lockfile) {
            break;
        }
    }
    /* eslint-enable no-await-in-loop */
    return result;
}

/**
 * Reverts changes from the "forceSharedFormat" write option if necessary.
 */
function convertFromLockfileFileMutable(lockfileFile: LockfileFile): Lockfile {
    if (typeof lockfileFile?.['importers'] === 'undefined') {
        lockfileFile.importers = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            '.': {
                specifiers: lockfileFile['specifiers'] ?? {},
                dependenciesMeta: lockfileFile['dependenciesMeta'],
                publishDirectory: lockfileFile['publishDirectory']
            }
        };
        delete lockfileFile.specifiers;
        for (const depType of DEPENDENCIES_FIELDS) {
            if (lockfileFile[depType] !== null) {
                lockfileFile.importers['.'][depType] = lockfileFile[depType];
                delete lockfileFile[depType];
            }
        }
    }
    return lockfileFile as Lockfile;
}
