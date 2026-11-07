import { randomUUID } from 'node:crypto';
import { invariant } from '../../../../packages/contracts/src/errors.ts';
import { integer, resourceId } from '../../../../packages/domain/src/validation.ts';
import { scriptToDraftOperations } from '../../../../packages/domain/src/script-scenes.ts';
import type { ApplicationContext } from './context.ts';

/** Copies one immutable script version into reviewable board operations. */
export function storyScriptToStoryboard(context:Pick<ApplicationContext,'stories'|'board'>,
  storyId:string,input:{projectId:string;scriptVersion:number;expectedBoardRevision:number}) {
  const id=resourceId(storyId),projectId=resourceId(input.projectId);
  integer(input.scriptVersion,'剧本版本',1,Number.MAX_SAFE_INTEGER);
  integer(input.expectedBoardRevision,'分镜版本',0,Number.MAX_SAFE_INTEGER);
  const link=context.stories.links(id).find(item=>item.projectId===projectId);
  invariant(link && link.scriptVersion===input.scriptVersion,'STORY_PROJECT_MISMATCH',
    '这个作品没有关联指定的剧本版本，请从故事库创建对应作品',409);
  const script=context.stories.script(id,input.scriptVersion);
  const board=context.board.snapshot(projectId);
  invariant(board.revision===input.expectedBoardRevision,'REVISION_CONFLICT','分镜版本已改变，请重新载入',409);
  return context.board.createDraft(projectId,{
    baseRevision:board.revision,
    operations:scriptToDraftOperations(script.text,()=>`draftop_${randomUUID()}`),
    source:'manual',
  });
}
