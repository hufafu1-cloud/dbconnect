// 新建对象的 SQL 模板（按方言）
// dialectOf: 连接类型 → 模板方言
const DIALECT = { mysql: 'mysql', oceanbase: 'mysql', postgres: 'postgres', mssql: 'mssql', sqlite: 'sqlite', clickhouse: 'clickhouse', oboracle: 'oracle' };

const T = {
  mysql: {
    routine: `-- MySQL 存储过程（整段一次执行，无需 DELIMITER）
CREATE PROCEDURE proc_demo(IN p_id INT)
BEGIN
  SELECT * FROM 某个表 WHERE id = p_id;
END`,
    trigger: `CREATE TRIGGER trg_demo BEFORE INSERT ON 表名
FOR EACH ROW
BEGIN
  SET NEW.created_at = NOW();
END`,
    event: `CREATE EVENT evt_demo
ON SCHEDULE EVERY 1 DAY
DO
BEGIN
  DELETE FROM 日志表 WHERE created_at < NOW() - INTERVAL 30 DAY;
END`,
  },
  postgres: {
    routine: `CREATE OR REPLACE FUNCTION fn_demo(p_id integer)
RETURNS TABLE(id integer, name text) AS $$
BEGIN
  RETURN QUERY SELECT t.id, t.name FROM 某个表 t WHERE t.id = p_id;
END;
$$ LANGUAGE plpgsql;`,
    trigger: `CREATE OR REPLACE FUNCTION trg_fn_demo() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_demo BEFORE UPDATE ON 表名
FOR EACH ROW EXECUTE FUNCTION trg_fn_demo();`,
    sequence: `CREATE SEQUENCE seq_demo START WITH 1 INCREMENT BY 1;`,
  },
  mssql: {
    routine: `CREATE PROCEDURE dbo.proc_demo @id INT
AS
BEGIN
  SET NOCOUNT ON;
  SELECT * FROM 某个表 WHERE id = @id;
END
GO`,
    trigger: `CREATE TRIGGER dbo.trg_demo ON dbo.表名
AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;
  -- 触发器逻辑
END
GO`,
    sequence: `CREATE SEQUENCE dbo.seq_demo START WITH 1 INCREMENT BY 1;`,
  },
  sqlite: {
    trigger: `CREATE TRIGGER trg_demo AFTER INSERT ON 表名
BEGIN
  UPDATE 表名 SET created_at = datetime('now') WHERE rowid = NEW.rowid;
END;`,
  },
  clickhouse: {
    routine: `CREATE FUNCTION fn_demo AS (x) -> x + 1;`,
  },
  oracle: {
    routine: `CREATE OR REPLACE PROCEDURE proc_demo(p_id IN NUMBER) AS
BEGIN
  NULL; -- 过程逻辑
END;`,
    trigger: `CREATE OR REPLACE TRIGGER trg_demo
BEFORE INSERT ON 表名
FOR EACH ROW
BEGIN
  :NEW.created_at := SYSDATE;
END;`,
    sequence: `CREATE SEQUENCE seq_demo START WITH 1 INCREMENT BY 1 NOCACHE;`,
  },
};

export function objTemplate(connType, kind) {
  const d = T[DIALECT[connType] || 'mysql'] || {};
  return d[kind] || null;
}
