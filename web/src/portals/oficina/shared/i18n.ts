// Translator scoped to the office namespace (web/src/i18n/{es,en}/oficina.json): `ot('mostrador.search')`
// reads `oficina.mostrador.search`. Keys outside the namespace (common.*, corridors.*, reasons.*)
// go through the regular `t`.

import { useCallback } from 'react';
import { useT, type TFn } from '../../../app/i18n';

export const OFICINA_NS = 'oficina';

export function useOT(): TFn {
  const t = useT();
  return useCallback<TFn>((key, params) => t(`${OFICINA_NS}.${key}`, params), [t]);
}
