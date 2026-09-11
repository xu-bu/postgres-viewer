use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::env;
use tokio_postgres::{Client, Config, NoTls};

mod credentials;

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 500;

type HmacSha256 = Hmac<Sha256>;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
struct AppState {
    base_config: Config,
    ssl_mode: String,
    signer: RowSigner,
}

#[derive(Clone, Deserialize)]
struct ConnectionConfig {
    host: String,
    port: String,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct ConnectionIdentity {
    host: String,
    port: String,
    username: Option<String>,
}

impl ConnectionConfig {
    fn identity(&self) -> ConnectionIdentity {
        ConnectionIdentity { host: self.host.clone(), port: self.port.clone(), username: self.username.clone() }
    }
}

#[derive(Clone)]
struct RowSigner(Vec<u8>);

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct RowRef {
    #[serde(default)]
    connection: Option<ConnectionIdentity>,
    database: String,
    schema: String,
    table: String,
    key: BTreeMap<String, Value>,
}

impl RowSigner {
    fn new(secret: Vec<u8>) -> Result<Self> {
        if secret.len() < 32 {
            return Err("POSTGRESUI_ROWKEY_SECRET must be at least 32 bytes".into());
        }
        Ok(Self(secret))
    }

    fn sign(&self, value: &RowRef) -> Result<String> {
        let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        let mut mac = HmacSha256::new_from_slice(&self.0).map_err(|e| e.to_string())?;
        mac.update(&body);
        Ok(format!("{}.{}", URL_SAFE_NO_PAD.encode(&body), URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())))
    }

    fn verify(&self, token: &str) -> Result<RowRef> {
        let (body, signature) = token.split_once('.').ok_or("Invalid row reference")?;
        let body = URL_SAFE_NO_PAD.decode(body).map_err(|_| "Invalid row reference")?;
        let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| "Invalid row reference")?;
        let mut mac = HmacSha256::new_from_slice(&self.0).map_err(|e| e.to_string())?;
        mac.update(&body);
        mac.verify_slice(&signature).map_err(|_| "Invalid row reference")?;
        serde_json::from_slice(&body).map_err(|_| "Invalid row reference".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInfo {
    server: String,
    current_database: String,
    databases: Vec<String>,
}

#[derive(Serialize)]
struct SchemaInfo {
    name: String,
    tables: Vec<TableInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableInfo {
    name: String,
    table_type: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColumnInfo {
    name: String,
    data_type: String,
    udt_name: String,
    nullable: bool,
    has_default: bool,
    generated: bool,
    primary_key: bool,
    ordinal: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TableMetadata {
    schema: String,
    table: String,
    columns: Vec<ColumnInfo>,
    can_mutate: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RowItem {
    values: Value,
    row_ref: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RowPage {
    rows: Vec<RowItem>,
    page: u32,
    page_size: u32,
    total: i64,
    page_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableRequest {
    database: String,
    schema: String,
    table: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageRequest {
    database: String,
    schema: String,
    table: String,
    page: Option<u32>,
    page_size: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InsertRequest {
    database: String,
    schema: String,
    table: String,
    values: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRequest {
    row_ref: String,
    values: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRequest {
    row_ref: String,
    confirmed: bool,
}

fn quote_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

fn config_from_env() -> Result<(Config, String)> {
    let mut config = if let Ok(url) = env::var("DATABASE_URL") {
        url.parse::<Config>().map_err(|e| format!("Invalid DATABASE_URL: {e}"))?
    } else {
        let mut c = Config::new();
        c.host(&env::var("PGHOST").unwrap_or_else(|_| "localhost".into()));
        c.port(env::var("PGPORT").ok().and_then(|v| v.parse().ok()).unwrap_or(5432));
        c.user(&env::var("PGUSER").unwrap_or_else(|_| "postgres".into()));
        if let Ok(password) = env::var("PGPASSWORD") { c.password(password); }
        c.dbname(&env::var("PGDATABASE").unwrap_or_else(|_| "postgres".into()));
        c
    };
    if config.get_dbname().is_none() { config.dbname("postgres"); }
    let ssl_mode = env::var("PGSSLMODE").unwrap_or_else(|_| "prefer".into());
    Ok((config, ssl_mode))
}

fn connection_config(base: &Config, connection: Option<&ConnectionConfig>) -> Result<Config> {
    let Some(connection) = connection else { return Ok(base.clone()); };
    if connection.host.trim().is_empty() { return Err("Host is required".into()); }
    let port = connection.port.parse::<u16>().ok().filter(|port| *port > 0)
        .ok_or("Port must be between 1 and 65535")?;
    let mut config = Config::new();
    config.host(connection.host.trim()).port(port);
    if let Some(username) = connection.username.as_deref() {
        if username.trim().is_empty() { return Err("Username is required".into()); }
        config.user(username);
    } else if let Some(user) = base.get_user() {
        config.user(user);
    }
    if let Some(password) = connection.password.as_deref() {
        config.password(password);
    } else if connection.username.is_none() {
        if let Some(password) = base.get_password() { config.password(password); }
    }
    if let Some(database) = base.get_dbname() { config.dbname(database); }
    if let Some(options) = base.get_options() { config.options(options); }
    if let Some(name) = base.get_application_name() { config.application_name(name); }
    config.ssl_mode(base.get_ssl_mode());
    config.ssl_negotiation(base.get_ssl_negotiation());
    config.channel_binding(base.get_channel_binding());
    config.target_session_attrs(base.get_target_session_attrs());
    config.load_balance_hosts(base.get_load_balance_hosts());
    if let Some(timeout) = base.get_connect_timeout() { config.connect_timeout(*timeout); }
    if let Some(timeout) = base.get_tcp_user_timeout() { config.tcp_user_timeout(*timeout); }
    config.keepalives(base.get_keepalives());
    config.keepalives_idle(base.get_keepalives_idle());
    if let Some(interval) = base.get_keepalives_interval() { config.keepalives_interval(interval); }
    if let Some(retries) = base.get_keepalives_retries() { config.keepalives_retries(retries); }
    Ok(config)
}

async fn connect(state: &AppState, database: Option<&str>, connection: Option<&ConnectionConfig>) -> Result<Client> {
    let mut restored = connection.cloned();
    if let Some(connection) = restored.as_mut() {
        if connection.username.is_some() && connection.password.is_none() {
            connection.password = credentials::load(connection.identity()).await?;
        }
    }
    let connection = restored.as_ref();
    let mut config = connection_config(&state.base_config, connection)?;
    if let Some(database) = database { config.dbname(database); }
    if state.ssl_mode == "disable" {
        let (client, connection) = config.connect(NoTls).await.map_err(|e| connection_error(e, database))?;
        tauri::async_runtime::spawn(async move { let _ = connection.await; });
        return Ok(client);
    }
    if !matches!(state.ssl_mode.as_str(), "prefer" | "require" | "verify-ca" | "verify-full" | "allow") {
        return Err(format!("Unsupported PGSSLMODE: {}", state.ssl_mode));
    }
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(false)
        .build().map_err(|e| e.to_string())?;
    let connector = postgres_native_tls::MakeTlsConnector::new(connector);
    let (client, connection) = config.connect(connector).await
        .map_err(|e| connection_error(e, database))?;
    tauri::async_runtime::spawn(async move { let _ = connection.await; });
    Ok(client)
}

fn connection_error(error: tokio_postgres::Error, database: Option<&str>) -> String {
    format!("Could not connect{}: {error}", database.map(|d| format!(" to database {d}")).unwrap_or_default())
}

async fn columns(client: &Client, schema: &str, table: &str) -> Result<Vec<ColumnInfo>> {
    let sql = r#"
        SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable = 'YES',
               c.column_default IS NOT NULL, c.is_generated <> 'NEVER',
               EXISTS (
                 SELECT 1 FROM pg_index i
                 JOIN pg_class t ON t.oid = i.indrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                 WHERE i.indisprimary AND n.nspname = c.table_schema
                   AND t.relname = c.table_name AND a.attname = c.column_name
               ), c.ordinal_position
        FROM information_schema.columns c
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position"#;
    client.query(sql, &[&schema, &table]).await.map_err(|e| e.to_string())?.into_iter().map(|row| Ok(ColumnInfo {
        name: row.get(0), data_type: row.get(1), udt_name: row.get(2), nullable: row.get(3),
        has_default: row.get(4), generated: row.get(5), primary_key: row.get(6), ordinal: row.get(7),
    })).collect()
}

#[tauri::command]
async fn connect_server(connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<ConnectionInfo> {
    let client = connect(&state, None, connection.as_ref()).await?;
    let rows = client.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", &[]).await.map_err(|e| e.to_string())?;
    let databases = rows.into_iter().map(|r| r.get(0)).collect();
    let row = client.query_one("SELECT current_database(), COALESCE(inet_server_addr()::text, 'local') || ':' || inet_server_port()", &[]).await.map_err(|e| e.to_string())?;
    if let Some(connection) = connection.as_ref() {
        if let Some(password) = connection.password.as_ref() {
            credentials::save(connection.identity(), password.clone()).await?;
        }
    }
    Ok(ConnectionInfo { current_database: row.get(0), server: row.get(1), databases })
}

#[tauri::command]
async fn forget_connection_password(connection: ConnectionConfig) -> Result<()> {
    if connection.username.is_some() {
        credentials::remove(connection.identity()).await?;
    }
    Ok(())
}

#[tauri::command]
async fn list_schemas(database: String, connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<Vec<SchemaInfo>> {
    let client = connect(&state, Some(&database), connection.as_ref()).await?;
    let sql = r#"SELECT n.nspname, c.relname,
      CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' END
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname !~ '^pg_toast' ORDER BY n.nspname, c.relname"#;
    let rows = client.query(sql, &[]).await.map_err(|e| e.to_string())?;
    let mut groups: BTreeMap<String, Vec<TableInfo>> = BTreeMap::new();
    for row in rows { groups.entry(row.get(0)).or_default().push(TableInfo { name: row.get(1), table_type: row.get(2) }); }
    Ok(groups.into_iter().map(|(name, tables)| SchemaInfo { name, tables }).collect())
}

#[tauri::command]
async fn get_table_metadata(request: TableRequest, connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<TableMetadata> {
    let client = connect(&state, Some(&request.database), connection.as_ref()).await?;
    let cols = columns(&client, &request.schema, &request.table).await?;
    if cols.is_empty() { return Err("Table not found or has no visible columns".into()); }
    let can_mutate = cols.iter().any(|c| c.primary_key);
    Ok(TableMetadata { schema: request.schema, table: request.table, columns: cols, can_mutate })
}

#[tauri::command]
async fn get_rows(request: PageRequest, connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<RowPage> {
    let page_size = request.page_size.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let page = request.page.unwrap_or(0);
    let client = connect(&state, Some(&request.database), connection.as_ref()).await?;
    let cols = columns(&client, &request.schema, &request.table).await?;
    if cols.is_empty() { return Err("Table not found or has no visible columns".into()); }
    let pk: Vec<_> = cols.iter().filter(|c| c.primary_key).collect();
    let order = if pk.is_empty() { "ctid".into() } else { pk.iter().map(|c| quote_ident(&c.name)).collect::<Vec<_>>().join(", ") };
    let sql = format!("SELECT to_jsonb(t), count(*) OVER () FROM {} t ORDER BY {} LIMIT $1 OFFSET $2", qualified(&request.schema, &request.table), order);
    let offset = i64::from(page)
        .checked_mul(i64::from(page_size))
        .ok_or("Requested page is too large")?;
    let query_rows = client.query(&sql, &[&(page_size as i64), &offset]).await.map_err(|e| e.to_string())?;
    let total = query_rows.first().map(|r| r.get(1)).unwrap_or_else(|| 0);
    let mut rows = Vec::with_capacity(query_rows.len());
    for row in query_rows {
        let values: Value = row.get(0);
        let row_ref = if pk.is_empty() { None } else {
            let key = pk.iter().map(|c| (c.name.clone(), values.get(&c.name).cloned().unwrap_or(Value::Null))).collect();
            Some(state.signer.sign(&RowRef { connection: connection.as_ref().map(ConnectionConfig::identity), database: request.database.clone(), schema: request.schema.clone(), table: request.table.clone(), key })?)
        };
        rows.push(RowItem { values, row_ref });
    }
    let page_count = if total == 0 { 0 } else { ((total as u64 + page_size as u64 - 1) / page_size as u64) as u32 };
    Ok(RowPage { rows, page, page_size, total, page_count })
}

fn validate_values(values: &BTreeMap<String, Value>, cols: &[ColumnInfo], allow_pk: bool) -> Result<()> {
    for name in values.keys() {
        let col = cols.iter().find(|c| &c.name == name).ok_or_else(|| format!("Unknown column: {name}"))?;
        if col.generated { return Err(format!("Generated column cannot be changed: {name}")); }
        if !allow_pk && col.primary_key { return Err(format!("Primary key cannot be changed: {name}")); }
    }
    Ok(())
}

fn parameter_value(value: &Value) -> Option<String> {
    if value.is_null() { None } else if value.is_string() { value.as_str().map(str::to_owned) } else { Some(value.to_string()) }
}

fn mutation_parts(values: &BTreeMap<String, Value>, cols: &[ColumnInfo], start: usize) -> Result<(Vec<String>, Vec<Option<String>>)> {
    let mut expressions = Vec::new();
    let mut parameters = Vec::new();
    for (index, (name, value)) in values.iter().enumerate() {
        let col = cols.iter().find(|c| c.name == *name).ok_or_else(|| format!("Unknown column: {name}"))?;
        expressions.push(format!("${}::{}", index + start, quote_ident(&col.udt_name)));
        parameters.push(parameter_value(value));
    }
    Ok((expressions, parameters))
}

fn key_where(row_ref: &RowRef, cols: &[ColumnInfo], start: usize) -> Result<(String, Vec<Option<String>>)> {
    if row_ref.key.is_empty() { return Err("Row reference has no primary key".into()); }
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for (index, (name, value)) in row_ref.key.iter().enumerate() {
        let col = cols.iter().find(|c| c.name == *name && c.primary_key).ok_or("Row reference does not match the current primary key")?;
        clauses.push(format!("{} IS NOT DISTINCT FROM ${}::{}", quote_ident(name), index + start, quote_ident(&col.udt_name)));
        params.push(parameter_value(value));
    }
    Ok((clauses.join(" AND "), params))
}

#[tauri::command]
async fn insert_row(request: InsertRequest, connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<()> {
    if request.values.is_empty() { return Err("Provide at least one value".into()); }
    let client = connect(&state, Some(&request.database), connection.as_ref()).await?;
    let cols = columns(&client, &request.schema, &request.table).await?;
    validate_values(&request.values, &cols, true)?;
    let names: Vec<_> = request.values.keys().map(|n| quote_ident(n)).collect();
    let (expressions, params) = mutation_parts(&request.values, &cols, 1)?;
    let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
    let sql = format!("INSERT INTO {} ({}) VALUES ({})", qualified(&request.schema, &request.table), names.join(","), expressions.join(","));
    client.execute(&sql, &refs).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn update_row(request: UpdateRequest, connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<()> {
    if request.values.is_empty() { return Err("No values changed".into()); }
    let reference = state.signer.verify(&request.row_ref)?;
    if reference.connection != connection.as_ref().map(ConnectionConfig::identity) { return Err("Row reference belongs to another connection".into()); }
    let client = connect(&state, Some(&reference.database), connection.as_ref()).await?;
    let cols = columns(&client, &reference.schema, &reference.table).await?;
    validate_values(&request.values, &cols, false)?;
    let (expressions, mut params) = mutation_parts(&request.values, &cols, 1)?;
    let assignments = request.values.keys().zip(expressions).map(|(n, e)| format!("{} = {}", quote_ident(n), e)).collect::<Vec<_>>().join(",");
    let (where_sql, key_params) = key_where(&reference, &cols, params.len() + 1)?;
    params.extend(key_params);
    let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
    let sql = format!("UPDATE {} SET {} WHERE {}", qualified(&reference.schema, &reference.table), assignments, where_sql);
    let changed = client.execute(&sql, &refs).await.map_err(|e| e.to_string())?;
    if changed != 1 { return Err(format!("Expected one row to update; changed {changed}. Reload the table.")); }
    Ok(())
}

#[tauri::command]
async fn delete_row(request: DeleteRequest, connection: Option<ConnectionConfig>, state: tauri::State<'_, AppState>) -> Result<()> {
    if !request.confirmed { return Err("Delete must be explicitly confirmed".into()); }
    let reference = state.signer.verify(&request.row_ref)?;
    if reference.connection != connection.as_ref().map(ConnectionConfig::identity) { return Err("Row reference belongs to another connection".into()); }
    let client = connect(&state, Some(&reference.database), connection.as_ref()).await?;
    let cols = columns(&client, &reference.schema, &reference.table).await?;
    let (where_sql, params) = key_where(&reference, &cols, 1)?;
    let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params.iter().map(|v| v as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
    let sql = format!("DELETE FROM {} WHERE {}", qualified(&reference.schema, &reference.table), where_sql);
    let changed = client.execute(&sql, &refs).await.map_err(|e| e.to_string())?;
    if changed != 1 { return Err(format!("Expected one row to delete; changed {changed}. Reload the table.")); }
    Ok(())
}

#[tauri::command]
fn debug_log(message: String) {
    eprintln!("[DEBUG] {}", message);
}

pub fn run() {
    let (base_config, ssl_mode) = config_from_env().unwrap_or_else(|error| panic!("Configuration error: {error}"));
    let secret = env::var("POSTGRESUI_ROWKEY_SECRET").map(|v| v.into_bytes()).unwrap_or_else(|_| {
        use rand::RngCore;
        let mut bytes = vec![0; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });
    let signer = RowSigner::new(secret).unwrap_or_else(|error| panic!("Configuration error: {error}"));
    tauri::Builder::default()
        .manage(AppState { base_config, ssl_mode, signer })
        .invoke_handler(tauri::generate_handler![debug_log, connect_server, forget_connection_password, list_schemas, get_table_metadata, get_rows, insert_row, update_row, delete_row])
        .run(tauri::generate_context!())
        .expect("error while running Postgres UI");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_quoting_handles_quotes() {
        assert_eq!(quote_ident("odd\"name"), "\"odd\"\"name\"");
        assert_eq!(qualified("a", "b"), "\"a\".\"b\"");
    }

    #[test]
    fn row_refs_round_trip_and_reject_tampering() {
        let signer = RowSigner::new(vec![7; 32]).unwrap();
        let reference = RowRef { connection: None, database: "db".into(), schema: "public".into(), table: "people".into(), key: BTreeMap::from([("id".into(), Value::from(42))]) };
        let token = signer.sign(&reference).unwrap();
        assert_eq!(signer.verify(&token).unwrap(), reference);
        let mut bytes = token.into_bytes();
        bytes[3] = if bytes[3] == b'a' { b'b' } else { b'a' };
        assert!(signer.verify(&String::from_utf8(bytes).unwrap()).is_err());
    }

    #[test]
    fn page_size_is_bounded() {
        assert_eq!(0_u32.clamp(1, MAX_PAGE_SIZE), 1);
        assert_eq!(999_u32.clamp(1, MAX_PAGE_SIZE), MAX_PAGE_SIZE);
    }

    #[test]
    fn custom_connection_replaces_environment_endpoint_and_preserves_credentials() {
        let base: Config = "host=original,backup hostaddr=127.0.0.1,127.0.0.2 port=5432,5433 user=alice password=secret dbname=app sslmode=require application_name=postgresui connect_timeout=5".parse().unwrap();
        let connection = ConnectionConfig { host: "custom".into(), port: "6432".into(), username: None, password: None };
        let config = connection_config(&base, Some(&connection)).unwrap();
        assert_eq!(config.get_hosts(), &[tokio_postgres::config::Host::Tcp("custom".into())]);
        assert!(config.get_hostaddrs().is_empty());
        assert_eq!(config.get_ports(), &[6432]);
        assert_eq!(config.get_user(), base.get_user());
        assert_eq!(config.get_password(), base.get_password());
        assert_eq!(config.get_dbname(), base.get_dbname());
        assert_eq!(config.get_ssl_mode(), base.get_ssl_mode());
        assert_eq!(config.get_application_name(), base.get_application_name());
        assert_eq!(config.get_connect_timeout(), base.get_connect_timeout());
        assert_eq!(base.get_ports(), &[5432, 5433]);
    }

    #[test]
    fn environment_connection_preserves_endpoint() {
        let base: Config = "host=environment port=6432 user=alice dbname=app".parse().unwrap();
        let config = connection_config(&base, None).unwrap();
        assert_eq!(config.get_hosts(), base.get_hosts());
        assert_eq!(config.get_ports(), base.get_ports());
    }

    #[test]
    fn custom_connection_rejects_invalid_endpoint() {
        for (host, port) in [(" ", "5432"), ("localhost", "0"), ("localhost", "65536"), ("localhost", "invalid")] {
            let connection = ConnectionConfig { host: host.into(), port: port.into(), username: None, password: None };
            assert!(connection_config(&Config::new(), Some(&connection)).is_err());
        }
    }

    #[test]
    fn custom_credentials_override_environment_without_trimming_passwords() {
        let base: Config = "host=original user=environment password=environment-secret dbname=app".parse().unwrap();
        let connection = ConnectionConfig {
            host: "custom".into(), port: "5432".into(),
            username: Some("alice".into()), password: Some("  secret :/@  ".into()),
        };
        let config = connection_config(&base, Some(&connection)).unwrap();
        assert_eq!(config.get_user(), Some("alice"));
        assert_eq!(config.get_password(), Some(b"  secret :/@  ".as_slice()));
        assert_eq!(config.get_dbname(), Some("app"));
        assert_eq!(base.get_user(), Some("environment"));
    }

    #[test]
    fn custom_username_does_not_inherit_environment_password() {
        let base: Config = "user=environment password=environment-secret".parse().unwrap();
        for password in [None, Some(String::new())] {
            let connection = ConnectionConfig {
                host: "custom".into(), port: "5432".into(), username: Some("alice".into()), password,
            };
            let config = connection_config(&base, Some(&connection)).unwrap();
            assert_eq!(config.get_user(), Some("alice"));
            assert_eq!(config.get_password(), connection.password.as_deref().map(str::as_bytes));
        }
    }

    #[test]
    fn custom_connection_rejects_blank_username() {
        let connection = ConnectionConfig {
            host: "custom".into(), port: "5432".into(), username: Some(" ".into()), password: None,
        };
        assert!(connection_config(&Config::new(), Some(&connection)).is_err());
    }

    #[test]
    fn row_references_identify_accounts_without_including_passwords() {
        let mut connection = ConnectionConfig {
            host: "custom".into(), port: "5432".into(),
            username: Some("alice".into()), password: Some("never-in-a-row-ref".into()),
        };
        let signer = RowSigner::new(vec![7; 32]).unwrap();
        let reference = RowRef {
            connection: Some(connection.identity()), database: "app".into(), schema: "public".into(),
            table: "people".into(), key: BTreeMap::from([("id".into(), Value::from(42))]),
        };
        let token = signer.sign(&reference).unwrap();
        let body = URL_SAFE_NO_PAD.decode(token.split_once('.').unwrap().0).unwrap();
        let json: Value = serde_json::from_slice(&body).unwrap();
        assert!(json["connection"].get("password").is_none());
        assert_eq!(json["connection"]["username"], "alice");
        assert_eq!(signer.verify(&token).unwrap(), reference);
        connection.password = Some("changed".into());
        assert_eq!(reference.connection, Some(connection.identity()));
        connection.username = Some("bob".into());
        assert_ne!(reference.connection, Some(connection.identity()));
    }
}
