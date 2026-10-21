import { ROLE_LABELS, ROLES, type AdminUser, type Role } from '@sistema-bar/shared';
import { useState } from 'react';
import { Badge, Button, EmptyState, ErrorBanner, Loading, Modal, PageHeader, SelectField, TextField, Toggle } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { errorMessage, useApiMutation, useApiQuery } from '../../lib/queries';

const PATH = '/admin/users';

const ROLE_HINTS: Record<Role, string> = {
  ADMIN: 'Tudo, inclusive cadastros e configurações',
  GERENTE: 'Cancelar itens, descontos, reabrir comandas, sangria',
  CAIXA: 'Abrir/fechar caixa e receber pagamentos',
  GARCOM: 'Abrir comandas e lançar pedidos',
  COZINHA: 'Só o painel da cozinha (marcar pedidos prontos)',
};

const SHOW_INACTIVE_KEY = 'admin.usuarios.inativos';

function readShowInactive(): boolean {
  try {
    return localStorage.getItem(SHOW_INACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

export function UsersPage() {
  const users = useApiQuery<AdminUser[]>(PATH);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  // Desativados ficam escondidos por padrão (o histórico deles continua no sistema).
  const [showInactive, setShowInactive] = useState(readShowInactive);
  const inactive = users.data?.filter((u) => !u.active).length ?? 0;
  const shown = users.data?.filter((u) => showInactive || u.active) ?? [];
  const toggleInactive = () => {
    const next = !showInactive;
    setShowInactive(next);
    try {
      localStorage.setItem(SHOW_INACTIVE_KEY, next ? '1' : '0');
    } catch {
      /* sem armazenamento: vale só nesta visita */
    }
  };

  return (
    <>
      <PageHeader
        title="Usuários"
        description="Usuários são criados só aqui. Para tirar o acesso de alguém, desative."
        action={<Button variant="primary" onClick={() => setEditing('new')}>+ Novo usuário</Button>}
      />
      <ErrorBanner message={errorMessage(users.error)} />
      {inactive > 0 && (
        <div className="mb-3 flex items-center justify-between gap-3 text-sm text-slate-400">
          <span>
            {showInactive ? `Mostrando todos, inclusive ${inactive} inativo(s).` : `${inactive} usuário(s) inativo(s) escondido(s).`}
          </span>
          <Button onClick={toggleInactive}>{showInactive ? 'Esconder inativos' : `Mostrar inativos (${inactive})`}</Button>
        </div>
      )}
      {users.isLoading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <EmptyState>Nenhum usuário ativo.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl bg-slate-900">
          {shown.map((u) => (
            <li key={u.id}>
              <button onClick={() => setEditing(u)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/60">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold">
                  {u.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${u.active ? '' : 'text-slate-500'}`}>{u.name}</span>
                  <span className="block text-xs text-slate-400">{u.login}</span>
                </span>
                {!u.active && <Badge tone="bad">Inativo</Badge>}
                {u.hasPin && <Badge>PIN</Badge>}
                <Badge tone={u.role === 'ADMIN' ? 'warn' : 'neutral'}>{ROLE_LABELS[u.role]}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <UserModal user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserModal({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { user: me } = useAuth();
  const isSelf = user?.id === me?.id;
  const save = useApiMutation([PATH]);
  const [name, setName] = useState(user?.name ?? '');
  const [login, setLogin] = useState(user?.login ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'GARCOM');
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [clearPin, setClearPin] = useState(false);

  const submit = () =>
    save.mutate(
      {
        method: user ? 'PUT' : 'POST',
        path: user ? `${PATH}/${user.id}` : PATH,
        body: user ? { name, login, role, active, password, pin, clearPin } : { name, login, role, active, password, pin },
      },
      { onSuccess: onClose },
    );

  return (
    <Modal
      title={user ? 'Editar usuário' : 'Novo usuário'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>Salvar</Button>
        </>
      }
    >
      <ErrorBanner message={errorMessage(save.error)} />
      <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!user} />
      <TextField
        label="Login"
        value={login}
        onChange={(e) => setLogin(e.target.value.toLowerCase())}
        autoCapitalize="none"
        autoCorrect="off"
        hint="Letras minúsculas, números, ponto, hífen"
      />
      <SelectField label="Perfil" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf} hint={ROLE_HINTS[role]}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </SelectField>
      <TextField
        label={user ? 'Nova senha' : 'Senha'}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={
          user
            ? 'Deixe em branco para manter. Trocar a senha desconecta os aparelhos do usuário.'
            : 'Mínimo 4 caracteres (ex.: 4 números). Para o administrador, use uma senha mais forte.'
        }
      />
      <TextField
        label={user?.hasPin ? 'Novo PIN de autorização' : 'PIN de autorização'}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        hint="4 a 6 números. Gerente e administrador usam para autorizar no caixa: cancelar item, desconto, estorno."
      />
      {user?.hasPin && <Toggle label="Remover o PIN atual" checked={clearPin} onChange={setClearPin} />}
      <Toggle
        label="Ativo"
        checked={active}
        onChange={setActive}
        hint={isSelf ? 'Você não pode desativar o próprio usuário.' : 'Desativar desconecta o usuário na hora.'}
      />
    </Modal>
  );
}
