/** Payload del access token JWT. `sub` es el id del usuario. */
export interface JwtPayload {
  sub: string;
  email: string;
  /**
   * `usuarios.token_version` vigente al firmar el token. Opcional porque los
   * tokens emitidos antes de agregar este claim no lo traen: se leen como 0.
   */
  tv?: number;
  /** Agregados por jsonwebtoken al firmar (segundos desde epoch). */
  iat?: number;
  exp?: number;
}
