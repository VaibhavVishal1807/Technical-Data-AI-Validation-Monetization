/**
 * users.js
 * The built-in accounts, one per role. A real deployment would use the
 * company identity provider (SSO / OAuth) instead.
 *
 * Only bcrypt HASHES are stored, never the passwords themselves. The
 * passwords are listed in README.md ("Sign-in accounts"):
 *   admin / admin123, analyst / analyst123, viewer / viewer123
 */
const USERS = [
  {
    username: 'admin',
    name: 'Platform Admin',
    role: 'admin',
    passwordHash: '$2b$10$uir6Kvp.rbRaj5qO.5D8oeACvFqEuoYozQTsujXlTr5960zNNsjGK',
  },
  {
    username: 'analyst',
    name: 'FinOps Analyst',
    role: 'analyst',
    passwordHash: '$2b$10$AD90nKrKNYEwU5YqQhTSV.bvrYGNWjyMB0fFaLymk4f.jzehiHbxe',
  },
  {
    username: 'viewer',
    name: 'Ops Viewer',
    role: 'viewer',
    passwordHash: '$2b$10$kNTG30prD4GEog28yYoBauozxYAPi8Odb7vmFR5AGxEC8eplznmt2',
  },
];

function findUser(username) {
  if (typeof username !== 'string') return null;
  return USERS.find((u) => u.username === username.trim().toLowerCase()) || null;
}

/** User data that is safe to send to the browser (no password hash). */
function publicUser(user) {
  return { username: user.username, name: user.name, role: user.role };
}

module.exports = { USERS, findUser, publicUser };
