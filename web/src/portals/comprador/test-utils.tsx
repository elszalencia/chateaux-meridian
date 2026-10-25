// Test helpers for the buyer portal: the providers every screen needs, and a fresh in-memory
// services stack with no latency (test files mock `app/api` with ./apiProxy).

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMockApi, type DemoApi } from '@chateaux/services';
import { DemoProvider } from '../../app/demo';
import { I18nProvider, type Lang } from '../../app/i18n';

export function freshApi(): DemoApi {
  return createMockApi({ minDelayMs: 0, maxDelayMs: 0 });
}

export function renderWithProviders(ui: ReactNode, lang: Lang = 'es') {
  return render(
    <I18nProvider initialLang={lang}>
      <DemoProvider>{ui}</DemoProvider>
    </I18nProvider>,
  );
}
