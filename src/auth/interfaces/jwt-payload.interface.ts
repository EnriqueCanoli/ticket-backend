/** Payload del access token JWT. `sub` es el id del usuario. */
export interface JwtPayload {
  sub: string;
  email: string;
}
