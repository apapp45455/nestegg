// Write a temp file, then rename it over the target (atomic): a forced quit or crash mid-write never leaves an empty file.
// On Windows the rename fails (EPERM, EACCES, EBUSY) while another read has the target open, for example the pet
// refreshing while settings are saved, so it retries for about a second before giving up
import { rename, writeFile } from 'node:fs/promises'

const BUSY = ['EPERM', 'EACCES', 'EBUSY']

export async function writeAtomic(file, data) {
  await writeFile(`${file}.tmp`, data)
  for (let wait = 10; ; wait *= 2) {
    try {
      return await rename(`${file}.tmp`, file)
    } catch (e) {
      if (wait > 640 || !BUSY.includes(e.code)) throw e
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}
