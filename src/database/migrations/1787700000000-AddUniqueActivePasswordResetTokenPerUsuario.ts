import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Defensa en profundidad a nivel BD para el invariante "como máximo un
 * password_reset_token vigente (`used_at IS NULL`) por usuario" (BE-03), que
 * hasta ahora solo garantizaba la aplicación: `forgotPassword()` borraba
 * cualquier token previo antes de insertar el nuevo, pero como dos
 * statements sueltos sin transacción ni lock. Bajo peticiones concurrentes a
 * `POST /auth/forgot-password` para el mismo usuario, cada DELETE corría
 * contra una foto tomada antes de que las demás hicieran commit (READ
 * COMMITTED), así que ninguna veía las filas insertadas por las otras —
 * resultado: 2+ filas vigentes simultáneas, todas válidas en
 * `POST /auth/reset-password`, incluida la "vieja" incluso después de que la
 * "nueva" ya se hubiera usado.
 *
 * El fix real (serializar con `SELECT ... FOR UPDATE` sobre la fila de
 * `usuarios` dentro de una transacción, igual que resetPassword() ya hacía
 * sobre la fila del token) va en `AuthService.forgotPassword()`. Este índice
 * cumple el mismo rol que `UQ_refresh_tokens_token_hash` para
 * `refresh_tokens`: una garantía a nivel de base de datos que no depende de
 * que la lógica de aplicación esté libre de bugs, ni de que un camino futuro
 * reintroduzca un check-then-act sin lock.
 *
 * Parcial (`WHERE used_at IS NULL`) y no un UNIQUE simple sobre `usuario_id`
 * porque un mismo usuario sí acumula legítimamente muchas filas *usadas* a
 * lo largo del tiempo (una por cada reset de contraseña exitoso) — la
 * unicidad solo aplica entre filas vigentes.
 *
 * Limpieza previa necesaria: al momento de escribir esta migración, la base
 * de desarrollo ya tenía filas duplicadas vigentes para varios usuarios
 * (producto del propio bug BE-03 reproducido en QA), así que un
 * `CREATE UNIQUE INDEX` directo fallaría. El `UPDATE` de abajo resuelve cada
 * grupo de duplicados quedándose con la fila vigente más reciente
 * (`created_at DESC`, desempatado por `id DESC` igual que el tie-breaker de
 * `resetPassword()`) y marca las demás como usadas (`used_at = now()`) —
 * coherente con la regla de negocio ("pedir un código nuevo invalida
 * cualquier solicitud anterior vigente"), no con "ya se usaron" en sentido
 * estricto, pero es el estado más cercano al que debieron haber quedado. Si
 * esta migración corre contra una base sin duplicados (caso normal a
 * futuro), el `UPDATE` no afecta ninguna fila.
 *
 * `down()` solo elimina el índice: no intenta revertir la limpieza de datos
 * (no hay forma de distinguir, después del hecho, qué filas quedaron
 * `used_at` por esta migración de las que ya estaban legítimamente usadas).
 */
export class AddUniqueActivePasswordResetTokenPerUsuario1787700000000 implements MigrationInterface {
  name = 'AddUniqueActivePasswordResetTokenPerUsuario1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "password_reset_tokens" AS t
      SET "used_at" = now()
      WHERE t."used_at" IS NULL
        AND t."id" NOT IN (
          SELECT DISTINCT ON ("usuario_id") "id"
          FROM "password_reset_tokens"
          WHERE "used_at" IS NULL
          ORDER BY "usuario_id", "created_at" DESC, "id" DESC
        );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_password_reset_tokens_usuario_id_vigente"
        ON "password_reset_tokens" ("usuario_id")
        WHERE "used_at" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_password_reset_tokens_usuario_id_vigente";
    `);
  }
}
