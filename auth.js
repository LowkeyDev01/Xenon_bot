import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { onlineDBClient as pool } from './db.js';

export async function usePostgresAuthState() {
    async function readData(id) {
        const { rows } = await pool.query(
            'SELECT data FROM whatsapp_auth WHERE id = $1',
            [id]
        );
        if (!rows[0]) return null;
        return JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver);
    }

    async function writeData(id, data) {
        await pool.query(
            `INSERT INTO whatsapp_auth (id, data, updated_at) 
             VALUES ($1, $2, NOW())
             ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
            [id, JSON.stringify(data, BufferJSON.replacer)]
        );
    }

    async function removeData(id) {
        await pool.query('DELETE FROM whatsapp_auth WHERE id = $1', [id]);
    }

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const value = await readData(`${type}-${id}`);
                        if (value) data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    for (const [type, ids] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(ids || {})) {
                            if (value) {
                                await writeData(`${type}-${id}`, value);
                            } else {
                                await removeData(`${type}-${id}`);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', state.creds);
        }
    };
}