import { Converter } from '../../features/currency/Converter.tsx';
import { PageHeader } from '../../features/transactions/ui.tsx';
import { useT } from '../../lib/i18n.ts';

export default function ConverterPage() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t('converter.page.currencyConverter', 'Currency converter')}>
        {t(
          'converter.page.exactDecimalConversionWith',
          'Exact decimal conversion with historical rates by date.',
        )}
      </PageHeader>
      <Converter />
    </div>
  );
}
