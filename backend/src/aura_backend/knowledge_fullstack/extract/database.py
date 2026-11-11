"""DatabaseExtractor.

A port of packages/knowledge-fullstack/src/extract/database.ts — tables,
ORM models, columns, foreign keys, indexes and migrations from real SQL,
TypeORM, Prisma, Sequelize and Mongoose sources.
"""

from __future__ import annotations

from ...core import js_regex
from ..types import Entity, SourceFile
from .extractor import LineMap, make_entity, snippet_around

_TS_ORM_SIGNALS = js_regex.compile(
    r"@Entity|@Column|@PrimaryColumn|@PrimaryGeneratedColumn|sequelize\.define|"
    r"new\s+Schema|mongoose\.model|extends\s+Model"
)
_MIGRATION_DIR = js_regex.compile(r"(?:^|/)migrations?/", "i")
_CREATE_TABLE = js_regex.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"'`]?([A-Za-z0-9_.]+)[\"'`]?"
    r"\s*\(([\s\S]*?)\);",
    "gi",
)
_COLUMN = js_regex.compile(r"^\s*[\"'`]?([A-Za-z0-9_]+)[\"'`]?\s+[A-Za-z]", "gm")
_NOT_A_COLUMN = js_regex.compile(
    r"^(primary|foreign|constraint|unique|index|key|check)$", "i"
)
_FOREIGN_KEY = js_regex.compile(
    r"FOREIGN\s+KEY\s*\(\s*[\"'`]?([A-Za-z0-9_]+)[\"'`]?\s*\)\s*REFERENCES"
    r"\s+[\"'`]?([A-Za-z0-9_.]+)",
    "gi",
)
_SCHEMA_PREFIX = js_regex.compile(r"^.*\.")
_INDEX = js_regex.compile(
    r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+[\"'`]?([A-Za-z0-9_]+)[\"'`]?\s+ON"
    r"\s+[\"'`]?([A-Za-z0-9_.]+)",
    "gi",
)
_SQL_SUFFIX = js_regex.compile(r"\.sql$", "i")
_PRISMA_MODEL = js_regex.compile(r"model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}", "g")
_PRISMA_COLUMN = js_regex.compile(r"^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_\[\]?]+)", "gm")
_PRISMA_RELATION = js_regex.compile(
    r"^\s*[A-Za-z0-9_]+\s+([A-Z][A-Za-z0-9_]*)(\[\])?\s", "gm"
)
_PRISMA_MAP = js_regex.compile(r"@@map\(\s*\"([^\"]+)\"")
_TYPEORM_ENTITY = js_regex.compile(
    r"@Entity\s*\(\s*(?:[`'\"]([^`'\"]+)[`'\"])?\s*\)\s*(?:export\s+)?"
    r"class\s+([A-Za-z0-9_]+)",
    "g",
)
_TYPEORM_COLUMN = js_regex.compile(
    r"@(?:Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn)"
    r"\s*\([^)]*\)\s*([A-Za-z0-9_]+)",
    "g",
)
_TYPEORM_RELATION = js_regex.compile(
    r"@(?:ManyToOne|OneToMany|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*([A-Za-z0-9_]+)",
    "g",
)
_SEQUELIZE = js_regex.compile(r"sequelize\.define\s*\(\s*[`'\"]([^`'\"]+)[`'\"]", "g")
_MONGOOSE = js_regex.compile(r"mongoose\.model\s*\(\s*[`'\"]([^`'\"]+)[`'\"]", "g")


def _is_sql(file: SourceFile) -> bool:
    return file.language == "sql" or file.ext == ".sql"


def _is_prisma(file: SourceFile) -> bool:
    return file.name.lower().endswith(".prisma")


def _is_ts_orm(file: SourceFile) -> bool:
    return (file.language in ("typescript", "javascript")
            and bool(_TS_ORM_SIGNALS.search(file.text)))


class DatabaseExtractor:
    id = "database"

    def applies_to(self, file: SourceFile) -> bool:
        return (_is_sql(file) or _is_prisma(file) or _is_ts_orm(file)
                or bool(_MIGRATION_DIR.search(file.rel_path)))

    def extract(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        if _is_sql(file):
            return self._sql(file, lines)
        if _is_prisma(file):
            return self._prisma(file, lines)
        return self._ts_orm(file, lines)

    def _sql(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        text = file.text
        entities: list[Entity] = []
        tables: dict[str, None] = {}

        for match in _CREATE_TABLE.finditer(text):
            table = _SCHEMA_PREFIX.sub("", match.group(1), count=1)
            tables[table] = None
            body = match.group(2)
            columns = [
                c.group(1) for c in _COLUMN.finditer(body)
                if not _NOT_A_COLUMN.search(c.group(1))
            ]
            foreign_keys = [
                {"column": fk.group(1),
                 "refTable": _SCHEMA_PREFIX.sub("", fk.group(2), count=1)}
                for fk in _FOREIGN_KEY.finditer(body)
            ]
            line = lines.line_at(match.start())
            entities.append(make_entity(
                "table", "database", table, file, line,
                f"Table {table} ({len(columns)} cols)",
                snippet_around(file, line, 6),
                {"columns": columns, "foreignKeys": foreign_keys, "indexes": []},
            ))

        for index in _INDEX.finditer(text):
            table = _SCHEMA_PREFIX.sub("", index.group(2), count=1)
            existing = next(
                (e for e in entities if e.kind == "table" and e.name == table), None
            )
            if existing:
                existing.metadata["indexes"].append(index.group(1))

        mig_name = _SQL_SUFFIX.sub("", file.name, count=1)
        entities.append(make_entity(
            "migration", "database", mig_name, file, 1, f"Migration {mig_name}",
            None, {"tables": list(tables)},
        ))
        return entities

    def _prisma(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        entities: list[Entity] = []
        for match in _PRISMA_MODEL.finditer(file.text):
            name = match.group(1)
            body = match.group(2)
            columns = [c.group(1) for c in _PRISMA_COLUMN.finditer(body)]
            relations = [r.group(1) for r in _PRISMA_RELATION.finditer(body)]
            mapped_match = _PRISMA_MAP.search(body)
            mapped = mapped_match.group(1) if mapped_match else name
            line = lines.line_at(match.start())
            entities.append(make_entity(
                "orm-model", "database", name, file, line, f"Prisma model {name}",
                snippet_around(file, line, 6),
                {"tableName": mapped, "columns": columns,
                 "relations": list(dict.fromkeys(relations))},
            ))
            entities.append(make_entity(
                "table", "database", mapped, file, line, f"Table {mapped}", None,
                {"columns": columns, "foreignKeys": [], "indexes": []},
            ))
        return entities

    def _ts_orm(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        text = file.text
        entities: list[Entity] = []

        for match in _TYPEORM_ENTITY.finditer(text):
            table_name = match.group(1) or match.group(2).lower()
            cname = match.group(2)
            body = text[match.start():match.start() + 2000]
            columns = [c.group(1) for c in _TYPEORM_COLUMN.finditer(body)]
            relations = [r.group(1) for r in _TYPEORM_RELATION.finditer(body)]
            line = lines.line_at(match.start())
            entities.append(make_entity(
                "orm-model", "database", cname, file, line, f"ORM model {cname}",
                snippet_around(file, line, 4),
                {"tableName": table_name, "columns": columns,
                 "relations": list(dict.fromkeys(relations))},
            ))
            entities.append(make_entity(
                "table", "database", table_name, file, line, f"Table {table_name}",
                None, {"columns": columns, "foreignKeys": [], "indexes": []},
            ))

        for match in _SEQUELIZE.finditer(text):
            line = lines.line_at(match.start())
            name = match.group(1)
            entities.append(make_entity(
                "orm-model", "database", name, file, line,
                f"Sequelize model {name}", None, {"tableName": name},
            ))
            entities.append(make_entity(
                "table", "database", name, file, line, f"Table {name}", None,
                {"columns": [], "foreignKeys": [], "indexes": []},
            ))

        for match in _MONGOOSE.finditer(text):
            line = lines.line_at(match.start())
            name = match.group(1)
            entities.append(make_entity(
                "orm-model", "database", name, file, line,
                f"Mongoose model {name}", None, {"tableName": name.lower()},
            ))

        return entities
