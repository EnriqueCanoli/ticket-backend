import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invalidación inmediata de access tokens tras restablecer la contraseña
 * (POST /auth/reset-password). Cada access token lleva el claim `tv` con el
 * valor de `token_version` vigente al firmarlo; JwtStrategy.validate()
 * rechaza con 401 cualquier token cuyo `tv` no coincida con el valor actual,
 * y resetPassword() incrementa esta columna de forma atómica en la misma
 * transacción en que cambia `password_hash`.
 *
 * Se eligió un contador en vez de `password_changed_at` comparado con `iat`
 * porque `iat` tiene precisión de segundos: con cualquier umbral, o un token
 * emitido en el mismo segundo pero antes del reset sobrevive, o un login
 * legítimo en el mismo segundo después del reset recibe 401. Además, el
 * contador no depende de los relojes del proceso Node ni de Postgres.
 *
 * Compatibilidad: `DEFAULT 0` y los tokens emitidos antes de este despliegue
 * (sin claim `tv`) se leen como 0, así que coinciden mientras el usuario no
 * haya hecho ningún reset. El despliegue no cierra la sesión de nadie.
 */
export class AddTokenVersionToUsuarios1787690000000 implements MigrationInterface {
  name = 'AddTokenVersionToUsuarios1787690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" ADD COLUMN "token_version" integer NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" DROP COLUMN IF EXISTS "token_version";
    `);
  }
}
