/** Identidad resuelta de quien hace la consulta. */
export type Identity =
  | { mode: "direct"; username: string; password: string } // Basic Auth
  | { mode: "assume"; username: string }; // OAuth (SET ROLE)
