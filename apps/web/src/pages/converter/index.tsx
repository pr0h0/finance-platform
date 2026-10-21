import { Converter } from '../../features/currency/Converter.tsx';
import { PageHeader } from '../../features/transactions/ui.tsx';

export default function ConverterPage() {
  return (
    <div>
      <PageHeader title="Currency converter">
        Exact decimal conversion with historical rates by date.
      </PageHeader>
      <Converter />
    </div>
  );
}
