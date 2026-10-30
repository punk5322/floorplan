/** Notes kept in memory. */
const notes: string[] = [];
export const listNotes = () => [...notes].reverse();
export const addNote = (text: string) => { notes.push(text); return "saved"; };
