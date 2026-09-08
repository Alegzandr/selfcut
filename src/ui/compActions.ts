import { useStore } from '../store/store';
import { compUsages, findComp } from '../model';
import { t } from '../i18n';

/**
 * The two composition actions that have to ask before they act, in one place so
 * every surface that offers them asks the same question.
 *
 * Both destroy something the user cannot see from where they are standing: the
 * attributes a comp clip carries as a single layer, and the clips elsewhere in
 * the project that play a composition being deleted. A menu row, an inspector
 * button and a card should not each have their own opinion about that.
 */

/**
 * Dissolve a comp clip back onto the timeline that was playing it, asking first
 * when the group carries a grade, a mask, fades or a speed that has nowhere to
 * go once there is no single layer to hold it.
 */
export async function decomposeWithConfirm(clipId: string): Promise<void> {
  const st = useStore.getState;
  if (
    st().compAttributesLost(clipId) &&
    !(await st().requestConfirm({
      title: t('comp.decomposeTitle'),
      message: t('comp.decomposeMessage'),
      confirmLabel: t('comp.decompose'),
      danger: true,
    }))
  ) {
    return;
  }
  st().decompose(clipId);
}

/**
 * Delete a composition, naming how many clips go with it. A composition nothing
 * plays is removed without a question: there is nothing to lose.
 */
export async function removeCompWithConfirm(compId: string): Promise<void> {
  const st = useStore.getState;
  const uses = compUsages(st().project, compId).length;
  if (uses > 0) {
    const ok = await st().requestConfirm({
      title: t('comp.deleteTitle'),
      message: t('comp.deleteMessage', {
        name: findComp(st().project, compId)?.name ?? '',
        count: uses,
      }),
      confirmLabel: t('comp.delete'),
      danger: true,
    });
    if (!ok) return;
  }
  st().removeComp(compId);
}
