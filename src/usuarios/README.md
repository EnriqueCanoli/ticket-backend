# `usuarios`

## 1. Propósito

Carpeta que contiene **únicamente la entidad `Usuario`**, sin controller, service, DTO ni módulo
(`UsuariosModule`) propio. No es un módulo funcional en el sentido del resto de este backend — es
puramente el modelo de datos raíz del que cuelgan las relaciones de los demás módulos por
`usuario_id`. Toda la lógica de negocio sobre esta entidad (crear, autenticar, leer perfil, PIN)
vive en [`src/auth/`](../auth/README.md), que es su único consumidor con acceso real de datos.

Este README existe como carpeta separada (en vez de fusionarse dentro de `auth/README.md`) para
mantener la convención de "un README por carpeta de módulo bajo `src/`" — aunque esta carpeta no
tenga comportamiento propio, sí tiene un archivo (`entities/usuario.entity.ts`) que otros tres
módulos referencian.

## 2. Estructura real

```
src/usuarios/
└── entities/
    └── usuario.entity.ts
```

Nada más. No hay `usuarios.module.ts` — la entidad se registra directamente en dos lugares:

- `app.module.ts` → `TypeOrmModule.forRootAsync({ ..., entities: [Usuario, Producto, Ticket, TicketItem, RefreshToken] })` (config raíz de conexión).
- `src/auth/auth.module.ts` → `TypeOrmModule.forFeature([Usuario, RefreshToken])` — esto es lo único
  que le da a `AuthService` un `Repository<Usuario>` inyectable.
- También listada en `src/database/data-source.ts` (entities del datasource que usa el CLI de
  migraciones).

## 3. Entidad `Usuario`

`@Entity('usuarios')`:

| Campo (prop / columna) | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | `uuid`, PK | — | `gen_random_uuid()` en BD |
| `email` / `email` | `varchar(255)` | NOT NULL | Sin `unique: true` en el decorador **a propósito** — la unicidad real es un índice funcional sobre `LOWER(email)`, no expresable con el decorador estándar (ver §4) |
| `passwordHash` / `password_hash` | `varchar(255)` | NOT NULL | hash bcryptjs (`SALT_ROUNDS=10`, ver `auth/README.md`) |
| `phone` / `phone` | `varchar(10)`, `unique: true` | NOT NULL | Acá el decorador sí coincide con la constraint real (unique simple) |
| `pin` / `pin` | `varchar(4)` | NOT NULL | Texto plano, sin `unique` — dos cuentas pueden compartir PIN. Ver decisión de producto en `auth/README.md` §5 |
| `aceptoTerminos` / `acepto_terminos` | `boolean` | NOT NULL | Sin default en el decorador (`synchronize: false`; el `DEFAULT false` vive solo en la migración) |
| `createdAt` / `created_at` | `timestamptz`, `@CreateDateColumn` | NOT NULL | |
| `updatedAt` / `updated_at` | `timestamptz`, `@UpdateDateColumn` | NOT NULL | |

### Relaciones (`Usuario` es el lado "uno" en las tres, todas `@OneToMany`)

| Relación | Entidad relacionada | Vive en módulo |
|---|---|---|
| `tickets: Ticket[]` | `Ticket` (`ticket.usuario`) | `tickets` |
| `productos: Producto[]` | `Producto` (`producto.usuario`) | `productos` |
| `refreshTokens: RefreshToken[]` | `RefreshToken` (`refreshToken.usuario`) | `auth` |

## 4. Restricciones de BD (de las migraciones — `synchronize: false`)

Historia de `usuarios` a través de las migraciones, en orden:

1. `InitialSchema` — crea la tabla con `PK_usuarios`, `UQ_usuarios_email` (unique simple, luego
   reemplazada), columna original `pin_hash varchar(255)`.
2. `RenamePinHashToPinInUsuarios` — renombra `pin_hash`→`pin`, backfill de PIN aleatorio 0000-9999
   para filas existentes (el hash bcrypt viejo no era reversible ni cabía en `varchar(4)`), angosta
   el tipo.
3. `NormalizeUsuariosEmail` — dropea `UQ_usuarios_email`, crea `UQ_usuarios_email_lower` (índice
   único funcional sobre `LOWER(email)`).
4. `AddUniquePhoneToUsuarios` — agrega `UQ_usuarios_phone`.
5. `AddAceptoTerminosToUsuarios` — agrega la columna, sin backfill especial (filas viejas quedan en
   `false`).

**Constraints finales sobre `usuarios`**: `PK_usuarios(id)`, `UQ_usuarios_email_lower(LOWER(email))`,
`UQ_usuarios_phone(phone)`. Sin constraint sobre `pin` (intencional).

### FKs de otras tablas hacia `usuarios.id`

No hay endpoint de borrado de cuenta hoy (ni controller en `usuarios/` ni método de borrado en
`AuthService`), pero el esquema ya define qué pasaría si existiera:

| Tabla / FK | `ON DELETE` | Índice |
|---|---|---|
| `tickets.usuario_id → usuarios.id` | **sin especificar → default Postgres `NO ACTION`** | `IDX_tickets_usuario_id` |
| `productos.usuario_id → usuarios.id` | **sin especificar → default `NO ACTION`** | `IDX_productos_usuario_id` |
| `refresh_tokens.usuario_id → usuarios.id` | **`ON DELETE CASCADE`** | `IDX_refresh_tokens_usuario_id` |

El modelo queda asimétrico a propósito por consecuencia del diseño (no hay comentario explícito que
lo declare, pero se deduce): las sesiones (`refresh_tokens`) son desechables y se borran en cascada,
mientras que catálogo (`productos`) y ventas (`tickets`) quedan protegidos — un `DELETE FROM
usuarios` fallaría por violación de FK mientras el usuario tenga productos o tickets asociados.

## 5. Quién usa `Usuario`

- **`auth`** — único consumidor con acceso real de datos (`Repository<Usuario>` vía
  `TypeOrmModule.forFeature`). Toda la lógica de login/registro/perfil/PIN vive ahí.
- **`productos`** — relación `@ManyToOne` hacia `Usuario` en `Producto` (catálogo privado por
  cuenta vía `usuario_id`), sin repository propio sobre `Usuario`.
- **`tickets`** — misma relación `@ManyToOne` en `Ticket`, sin repository propio.
- **`reportes`** — ni siquiera tiene la relación de entidad; solo usa el tipo `Usuario` para tipar
  `req.user` en el guard JWT.

## 6. Gotcha

Si se busca `usuarios.controller.ts` o `usuarios.service.ts` esperando encontrar lógica de negocio,
no existe — toda la lógica que muta o lee `Usuario` está en `src/auth/`. Esta carpeta es solo el
modelo de datos compartido.
