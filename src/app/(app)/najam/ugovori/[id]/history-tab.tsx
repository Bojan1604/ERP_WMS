import { History } from 'lucide-react';
import { Badge, Empty, TableWrap } from '@/components/ui/misc';
import { contractHistory } from '@/server/queries/rentals';
import { dateTime } from '@/lib/format';

const ACTION_LABEL: Record<string, string> = {
  create: 'Otvoren', update: 'Uvjeti', status: 'Status', terminate: 'Otkaz', items: 'Uređaji', remove: 'Povrat', pause: 'Pauza naplate', resume: 'Naplata vraćena',
  add: 'Dodavanje', issue: 'Račun', draft: 'Nacrt', skip: 'Preskočeno',
};

export async function HistoryTab({ contractId, companyId }: { contractId: string; companyId: string }) {
  const rows = await contractHistory(companyId, contractId);
  if (!rows.length) {
    return (
      <TableWrap>
        <Empty icon={<History className="size-5" />} title="Nema zapisa" />
      </TableWrap>
    );
  }
  return (
    <TableWrap>
      <table className="data-table">
        <thead>
          <tr>
            <th>Vrijeme</th>
            <th>Korisnik</th>
            <th>Radnja</th>
            <th>Opis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{dateTime(r.at)}</td>
              <td className="whitespace-nowrap">{r.userName ?? '—'}</td>
              <td>
                <Badge>{ACTION_LABEL[r.action] ?? r.action}</Badge>
              </td>
              <td>{r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
