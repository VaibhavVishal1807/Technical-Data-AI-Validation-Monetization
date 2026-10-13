/** Users (admin only): who can sign in and what each role may do. */
import { useApi } from '../api';
import { PageHead, PageState, Section, TableSkeleton } from '../components/Common';
import DataTable from '../components/DataTable';
import { TagBadge } from '../components/Badges';

const COLUMNS = [
  { id: 'username', header: 'Username', accessorFn: (u) => u.username, cell: ({ row }) => <span className="font-mono font-medium">{row.original.username}</span> },
  { id: 'name', header: 'Name', accessorFn: (u) => u.name, cell: ({ row }) => row.original.name },
  { id: 'role', header: 'Role', accessorFn: (u) => u.role, cell: ({ row }) => <TagBadge className="text-foreground">{row.original.role}</TagBadge> },
  {
    id: 'permissions',
    header: 'Permissions',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="flex flex-wrap gap-2 py-2 whitespace-normal">
        {row.original.permissions.map((p) => <TagBadge key={p} className="font-mono">{p}</TagBadge>)}
      </span>
    ),
  },
];

export default function Users() {
  const users = useApi('/users');
  return (
    <>
      <PageHead title="Users and roles" subtitle="Demo accounts. Permissions are enforced by the API on every request; the menu only hides what a role cannot open." />
      <PageState {...users} skeleton={<TableSkeleton rows={3} />}>
        {users.data && (
          <Section flush>
            <DataTable label="Users" columns={COLUMNS} data={users.data.users} getRowId={(u) => u.username} emptyText="No users" />
          </Section>
        )}
      </PageState>
    </>
  );
}
