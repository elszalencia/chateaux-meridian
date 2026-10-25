// Test harness for office components: the real providers over the mocked in-page API (each test
// file mocks `app/api` with a zero-latency mock stack, so the seed is what the screens render).

import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { DemoProvider } from '../../../app/demo';
import { I18nProvider, type Lang } from '../../../app/i18n';

export function renderOffice(ui: ReactElement, lang: Lang = 'es') {
  return render(
    <I18nProvider initialLang={lang}>
      <DemoProvider>{ui}</DemoProvider>
    </I18nProvider>,
  );
}