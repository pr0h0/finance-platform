import { expect, test } from 'bun:test';
import { formatDate, formatMoney } from '@finplat/localization';
import { errorText, type TFn, translate } from '../../lib/i18n.ts';
import { notificationText } from './text.ts';

const bsT: TFn = (k, en, v) => translate('bs', k, en, v);
const bsFmt = {
  money: (m: { amount: string; currency: string }) => formatMoney(m, 'bs-BA'),
  date: (d: string) => formatDate(d, 'bs-BA'),
};

test('a coded server notification renders in Bosnian, whatever language it was stored in', () => {
  const n = notificationText(
    {
      title: 'Rent due tomorrow',
      body: '300.00 BAM is scheduled tomorrow.',
      code: 'bill_due_tomorrow',
      params: { name: 'Rent', amount: { amount: '1300.00', currency: 'BAM' }, date: '2026-10-16' },
    },
    bsT,
    bsFmt,
  );
  expect(n.title).toBe('Rent dospijeva sutra');
  expect(n.body).toBe(
    `${formatMoney({ amount: '1300.00', currency: 'BAM' }, 'bs-BA')} je zakazano za sutra.`,
  );
  expect(n.body).toContain('1.300,00');
  const late = notificationText(
    {
      title: 'x',
      body: 'y',
      code: 'bill_overdue',
      params: { name: 'Telefon', amount: { amount: '30.00', currency: 'BAM' }, date: '2026-10-12' },
    },
    bsT,
    bsFmt,
  );
  expect(late.body).toContain(formatDate('2026-10-12', 'bs-BA'));
  // Unknown code / no code: stored text unchanged.
  const old = { title: 'Old', body: 'text', code: null };
  expect(notificationText(old, bsT, bsFmt)).toBe(old);
  expect(notificationText({ ...old, code: 'future_kind' }, bsT, bsFmt).title).toBe('Old');
});

test('API field errors with a code are shown in Bosnian; bespoke ones keep the server text', () => {
  const err = {
    code: 'validation_failed',
    message: 'request validation failed',
    details: {
      fields: { name: 'required, at most 200 characters', note: 'use either categoryId or splits' },
      fieldCodes: { name: { code: 'required_max_length', params: { max: '200' } } },
    },
  };
  const text = errorText(err, 'bs');
  expect(text).toContain('name: obavezno, najviše 200 znakova');
  expect(text).toContain('note: use either categoryId or splits');
  expect(errorText(err, 'en')).toContain('name: required, at most 200 characters');
});
