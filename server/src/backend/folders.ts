import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { BackendError } from './types';

/** The folder a new workspace, tab or split opens in (openspec/changes/create-missing-folders). A folder that
 *  doesn't exist yet is created with its parents: a device with control could run mkdir in any shell anyway, so
 *  this adds no access. Call it last, once every other check on the request has passed, so a refused request
 *  leaves nothing on disk. `created` is the path when this call made it. */
export function ensureFolder(cwd:string):{path:string;created?:string} {
  if(!isAbsolute(cwd))throw new BackendError('invalid_cwd','Folder must be a full path, such as /home/you/project',400);
  const path=resolve(cwd);
  try {
    if(!statSync(path).isDirectory())throw new BackendError('invalid_cwd','That path is a file, not a folder',400);
    return {path};
  } catch(e) {
    if(e instanceof BackendError)throw e;
    const code=(e as NodeJS.ErrnoException).code;
    if(code==='ENOTDIR')throw new BackendError('invalid_cwd','Part of that path is a file, not a folder',400);
    if(code!=='ENOENT')throw new BackendError('folder_not_created',`The computer can't open that folder (${code??'error'})`,400);
  }
  try {mkdirSync(path,{recursive:true});}
  catch(e) {
    const code=(e as NodeJS.ErrnoException).code;
    if(code==='ENOTDIR'||code==='EEXIST')throw new BackendError('invalid_cwd','Part of that path is a file, not a folder',400);
    const why=code==='EACCES'||code==='EPERM'?'permission denied':code==='EROFS'?'the disk is read-only':code==='ENOSPC'?'the disk is full':code??'error';
    throw new BackendError('folder_not_created',`The computer couldn't create that folder: ${why}`,400);
  }
  return {path,created:path};
}

/** Adds `folderCreated` to a mutation's result, which the bridge notes in the console's Recent activity. */
export function withFolder(result:unknown,folder:{created?:string}|undefined):unknown {
  if(!folder?.created)return result;
  return result&&typeof result==='object'&&!Array.isArray(result)?{...result,folderCreated:folder.created}:{result,folderCreated:folder.created};
}
