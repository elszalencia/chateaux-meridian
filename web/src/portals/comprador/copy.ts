// The buyer portal's strings live in web/src/i18n/{es,en}/comprador.json under `comprador.portal`.
// `usePortalT` prefixes that path so call sites stay short; portal.i18n.test.ts checks that every
// `tp('...')` key resolves in both languages.

import { useCallback } from 'react';
import { useI18n, type TFn } from '../../app/i18n';

export const PORTAL_PREFIX = 'comprador.portal.';

export function usePortalT(): TFn {
  const { t } = useI18n();
  return useCallback<TFn>((key, params) => t(PORTAL_PREFIX + key, params), [t]);
}
