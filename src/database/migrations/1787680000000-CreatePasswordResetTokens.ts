import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega la tabla `password_reset_tokens`, requerida por el flujo "olvidé mi
 * contraseña" (código de 6 dígitos enviado por email, ver src/auth/README.md).
 * Sin UNIQUE sobre `code_hash` (a diferencia de `refresh_tokens.token_hash`):
 * el código no es globalmente único entre usuarios, la búsqueda siempre es
 * por `usuario_id` + comparación de hash.
 */
export class CreatePasswordResetTokens1787680000000 implements MigrationInterface {
  name = 'CreatePasswordResetTokens1787680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "password_reset_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "usuario_id" uuid NOT NULL,
        "code_hash" varchar(255) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "used_at" timestamptz NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_password_reset_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_password_reset_tokens_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id") ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_password_reset_tokens_usuario_id" ON "password_reset_tokens" ("usuario_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_tokens";`);
  }
}
