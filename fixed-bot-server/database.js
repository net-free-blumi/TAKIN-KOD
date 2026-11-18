// MOCKED for AI Studio Web environment - in-memory storage, no native addons
const store = new Map();

const db = {
  exec: () => {},
  prepare: (query) => ({
    get: (param) => store.get(param) || null,
    all: () => Array.from(store.values()),
    run: (phone, name, role = 'user', status = 'pending') => {
      if (phone) {
        store.set(phone, { phone, name: name || 'משתמש חדש', role, status });
      }
      return { changes: 1 };
    },
  }),
};

export default db;

