import { invoke } from "@tauri-apps/api/core";
import { loadConnections, saveConnections, sameConnection, type ConnectionConfig } from "./connections";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type SchemaInfo = { name: string; tables: { name: string; tableType: string }[] };
type ColumnInfo = { name: string; dataType: string; udtName: string; nullable: boolean; hasDefault: boolean; generated: boolean; primaryKey: boolean; ordinal: number };
type Metadata = { schema: string; table: string; columns: ColumnInfo[]; canMutate: boolean };
type RowItem = { values: Record<string, JsonValue>; rowRef: string | null };
type RowPage = { rows: RowItem[]; page: number; pageSize: number; total: number; pageCount: number };
type ConnectionInfo = { server: string; currentDatabase: string; databases: string[] };

// Connection state management
type ConnectionState = {
  id: string;
  config: ConnectionConfig;
  info: ConnectionInfo | null;
  error: string | null;
  database: string;
  selected: { schema: string; table: string } | null;
  metadata: Metadata | null;
  page: RowPage | null;
  viewMode: "grid" | "tree";
  currentFilter: { column: string; operator: string; value: string } | null;
  requestGeneration: number;
};

const connections = new Map<string, ConnectionState>();
let activeConnectionId: string | null = null;
let connectionCounter = 0;
let savedConnections: ConnectionConfig[] = [];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dbSelect = $<HTMLSelectElement>("database-select");
const status = $("connection-status");
const tree = $("schema-tree");
const grid = $("grid");
const gridHead = $("grid-head");
const gridScroll = $("grid-scroll");
const gridSpacer = $("grid-spacer");
const gridBody = $("grid-body");
const tabsContainer = $("connection-tabs");
const newConnectionButton = $("new-connection-button");

const ROW_HEIGHT = 39;
const OVERSCAN = 8;
let busy = false;
let lastFocus: HTMLElement | null = null;
let lastRenderedRange = { start: -1, end: -1 };

function getActiveConnection(): ConnectionState | null {
  return activeConnectionId ? connections.get(activeConnectionId) || null : null;
}

function currentGeneration(): number {
  const conn = getActiveConnection();
  return conn ? conn.requestGeneration : 0;
}

function isCurrent(generation: number, connection: ConnectionState): boolean {
  return connection === getActiveConnection() && generation === connection.requestGeneration;
}

function message(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Unexpected error";
}

function setBusy(value: boolean): void {
  busy = value;
  document.body.toggleAttribute("aria-busy", value);
}

function toast(text: string, error = false): void {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.textContent = text;
  $("toast-region").append(item);
  window.setTimeout(() => item.remove(), 4500);
}

function empty(element: Element): void {
  element.replaceChildren();
}

function button(text: string, className: string, action: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  el.addEventListener("click", action);
  return el;
}

function createConnectionId(): string {
  return `conn-${++connectionCounter}`;
}

function connectionLabel(config: ConnectionConfig): string {
  return config ? `${config.username ? `${config.username}@` : ""}${config.host}:${config.port}` : "Environment connection";
}

function createTab(id: string, label: string): void {
  const tab = document.createElement("div");
  tab.className = "connection-tab";
  tab.dataset.connectionId = id;

  const labelEl = document.createElement("span");
  labelEl.className = "connection-tab-label";
  labelEl.textContent = label;

  const closeBtn = document.createElement("button");
  closeBtn.className = "connection-tab-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close connection";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void closeConnection(id);
  });

  tab.append(labelEl, closeBtn);
  tab.addEventListener("click", () => {
    switchConnection(id);
    const connection = connections.get(id);
    if (connection?.error) reconnectConnection(connection);
  });
  tabsContainer.append(tab);
}

function updateTabs(): void {
  document.querySelectorAll(".connection-tab").forEach((tab) => {
    const el = tab as HTMLElement;
    const id = el.dataset.connectionId;
    el.classList.toggle("active", id === activeConnectionId);
    const connection = id ? connections.get(id) : null;
    if (connection) {
      const label = connectionLabel(connection.config);
      el.querySelector(".connection-tab-label")!.textContent = connection.error ? `${label} (disconnected)` : label;
      el.title = connection.error ? `${connection.error} — Click to reconnect` : label;
    }
  });
}

function switchConnection(id: string): void {
  if (activeConnectionId === id) return;
  activeConnectionId = id;
  updateTabs();
  renderConnectionState();
  if (getActiveConnection()?.info) void loadTree();
}

async function closeConnection(id: string, forget = true): Promise<void> {
  const connection = connections.get(id);
  if (forget && connection) {
    try {
      if (connection.config?.username) {
        await invoke("forget_connection_password", { connection: connection.config });
      }
      const remaining = savedConnections.filter((config) => !sameConnection(config, connection.config));
      saveConnections(localStorage, remaining);
      savedConnections = remaining;
    } catch (error) {
      toast(`Could not remove saved connection: ${message(error)}`, true);
      return;
    }
  }
  connections.delete(id);
  const tab = tabsContainer.querySelector(`[data-connection-id="${id}"]`);
  tab?.remove();

  if (activeConnectionId === id) {
    // Switch to another connection or show empty state
    const remainingIds = Array.from(connections.keys());
    if (remainingIds.length > 0) {
      switchConnection(remainingIds[0]!);
    } else {
      activeConnectionId = null;
      renderConnectionState();
    }
  }
}

function renderConnectionState(): void {
  const conn = getActiveConnection();

  if (!conn) {
    // No active connection
    status.textContent = "No connection";
    status.className = "connection-status";
    empty(dbSelect);
    dbSelect.disabled = true;
    empty(tree);
    $("empty-state").hidden = false;
    $("table-panel").hidden = true;
    return;
  }

  if (!conn.info) {
    status.textContent = conn.error ? "Disconnected" : "Connecting…";
    status.className = conn.error ? "connection-status error" : "connection-status";
    empty(dbSelect);
    dbSelect.disabled = true;
    empty(tree);
    $("empty-state").hidden = false;
    $("table-panel").hidden = true;
    if (conn.error) {
      const error = document.createElement("p");
      error.className = "tree-message";
      error.textContent = conn.error;
      tree.append(error, button("Reconnect", "quiet-button", () => reconnectConnection(conn)));
    }
    return;
  }

  // Update status
  status.textContent = `Connected to ${conn.info.server}`;
  status.className = "connection-status connected";

  // Update database selector
  empty(dbSelect);
  for (const name of conn.info.databases) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    option.selected = name === conn.database;
    dbSelect.append(option);
  }
  dbSelect.disabled = false;

  // Render tree and table state
  if (conn.selected && conn.metadata && conn.page) {
    $("empty-state").hidden = true;
    $("table-panel").hidden = false;
    $("table-breadcrumb").textContent = `${conn.database} / ${conn.selected.schema}`;
    $("table-title").textContent = conn.selected.table;
    renderGrid();
    updateRowSummary();
  } else {
    $("empty-state").hidden = false;
    $("table-panel").hidden = true;
  }
}

function updateRowSummary(): void {
  const conn = getActiveConnection();
  if (!conn || !conn.page || !conn.metadata) return;

  const first = conn.page.total ? conn.page.page * conn.page.pageSize + 1 : 0;
  const last = Math.min(conn.page.total, (conn.page.page + 1) * conn.page.pageSize);
  $("row-summary").textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${conn.page.total.toLocaleString()} rows${conn.metadata.canMutate ? "" : " · read only (no primary key)"}`;
  $("page-label").textContent = conn.page.pageCount ? `Page ${conn.page.page + 1} of ${conn.page.pageCount}` : "No pages";
  $<HTMLButtonElement>("prev-page").disabled = conn.page.page === 0;
  $<HTMLButtonElement>("next-page").disabled = conn.page.page + 1 >= conn.page.pageCount;
}

function reconnectConnection(connection: ConnectionState): void {
  if (connection.config) {
    openConnectionDialog(connection);
  } else {
    void createConnection(null, connection).catch((error) => toast(message(error), true));
  }
}

function openConnectionDialog(existing?: ConnectionState): void {
  const dialog = openModal(
    existing ? "Reconnect" : "New Connection",
    existing ? "Update your credentials to reconnect. Passwords are saved securely in your OS credential store." : "Enter PostgreSQL server details. Passwords are saved securely so connections reconnect automatically after restart."
  );

  const form = document.createElement("form");
  form.innerHTML = `
    <div class="form-field">
      <label for="conn-host">Host / IP Address</label>
      <input id="conn-host" name="host" type="text" value="localhost" required>
    </div>
    <div class="form-field">
      <label for="conn-port">Port</label>
      <input id="conn-port" name="port" type="number" min="1" max="65535" step="1" value="5432" required>
    </div>
    <div class="form-field">
      <label for="conn-username">Username</label>
      <input id="conn-username" name="username" type="text" value="postgres" autocomplete="username" autocapitalize="none" spellcheck="false" required>
    </div>
    <div class="form-field">
      <label for="conn-password">Password</label>
      <input id="conn-password" name="password" type="password" autocomplete="current-password">
    </div>
  `;

  dialog.body.append(form);
  if (existing?.config) {
    $<HTMLInputElement>("conn-host").value = existing.config.host;
    $<HTMLInputElement>("conn-port").value = existing.config.port;
    $<HTMLInputElement>("conn-username").value = existing.config.username ?? "postgres";
  }
  dialog.footer.append(button("Cancel", "quiet-button", dialog.close));

  const connectBtn = button(existing ? "Reconnect" : "Save & Connect", "primary-button", async () => {
    if (connectBtn.disabled || !form.reportValidity()) return;
    const host = $<HTMLInputElement>("conn-host").value.trim();
    const port = $<HTMLInputElement>("conn-port").value.trim();
    const username = $<HTMLInputElement>("conn-username").value.trim();
    const password = $<HTMLInputElement>("conn-password").value;

    if (!host || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      toast("Enter a host and a port between 1 and 65535", true);
      return;
    }
    if (!username) {
      toast("Please enter a username", true);
      return;
    }

    connectBtn.disabled = true;
    try {
      await createConnection({ host, port, username, password }, existing);
      dialog.close();
    } catch (error) {
      toast(message(error), true);
      connectBtn.disabled = false;
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    connectBtn.click();
  });
  dialog.footer.append(connectBtn);
}

async function createConnection(config: ConnectionConfig, existing?: ConnectionState, restoring = false): Promise<void> {
  const id = existing?.id ?? createConnectionId();

  const state: ConnectionState = existing ?? {
    id,
    config,
    info: null,
    error: null,
    database: "",
    selected: null,
    metadata: null,
    page: null,
    viewMode: "tree",
    currentFilter: null,
    requestGeneration: 0,
  };

  state.error = null;
  connections.set(id, state);
  if (!existing) createTab(id, connectionLabel(config));
  activeConnectionId = id;
  updateTabs();
  renderConnectionState();

  try {
    const info = await invoke<ConnectionInfo>("connect_server", { connection: config });
    if (!connections.has(id)) return;
    const otherConfigs = existing
      ? savedConnections.filter((saved) => !sameConnection(saved, existing.config)) : savedConnections;
    const configs = otherConfigs.some((saved) => sameConnection(saved, config))
      ? otherConfigs : [...otherConfigs, config];
    try {
      saveConnections(localStorage, configs);
    } catch (error) {
      throw new Error(`Could not save connection: ${message(error)}`);
    }
    savedConnections = configs;
    state.config = config;
    state.info = info;
    state.database = info.currentDatabase;
    updateTabs();

    if (activeConnectionId === id) {
      renderConnectionState();
      void loadTree();
    }
  } catch (error) {
    if (existing || restoring) {
      state.error = message(error);
      updateTabs();
      if (activeConnectionId === id) renderConnectionState();
    } else {
      await closeConnection(id, false);
    }
    throw error;
  }
}

async function loadTree(): Promise<void> {
  const conn = getActiveConnection();
  if (!conn?.info) return;

  const generation = ++conn.requestGeneration;
  conn.selected = null;
  conn.metadata = null;
  conn.page = null;

  $("empty-state").hidden = false;
  $("table-panel").hidden = true;
  empty(tree);

  const loading = document.createElement("p");
  loading.className = "tree-message";
  loading.textContent = "Loading schemas…";
  tree.append(loading);

  try {
    const schemas = await invoke<SchemaInfo[]>("list_schemas", { database: conn.database, connection: conn.config });
    if (!isCurrent(generation, conn)) return;

    empty(tree);
    if (!schemas.length) {
      const emptyMessage = document.createElement("p");
      emptyMessage.className = "tree-message";
      emptyMessage.textContent = "No visible tables.";
      tree.append(emptyMessage);
      return;
    }

    for (const schema of schemas) {
      const group = document.createElement("section");
      const list = document.createElement("ul");
      list.className = "table-list";

      const toggle = button("", "schema-toggle", () => {
        const collapsed = toggle.getAttribute("aria-expanded") === "false";
        toggle.setAttribute("aria-expanded", String(collapsed));
        list.hidden = !collapsed;
      });
      toggle.setAttribute("aria-expanded", "true");

      const caret = document.createElement("span");
      caret.className = "schema-caret";
      caret.textContent = "▾";
      const label = document.createElement("span");
      label.textContent = schema.name;
      toggle.append(caret, label);

      for (const table of schema.tables) {
        const li = document.createElement("li");
        const link = button(table.name, "table-link", () => selectTable(schema.name, table.name, link));
        link.title = `${table.tableType}: ${schema.name}.${table.name}`;
        link.dataset.schema = schema.name;
        link.dataset.table = table.name;
        li.append(link);
        list.append(li);
      }

      group.append(toggle, list);
      tree.append(group);
    }
  } catch (error) {
    if (!isCurrent(generation, conn)) return;
    empty(tree);
    const errorMessage = document.createElement("p");
    errorMessage.className = "tree-message";
    errorMessage.textContent = message(error);
    tree.append(errorMessage);
    toast(message(error), true);
  }
}

async function selectTable(schema: string, table: string, link: HTMLButtonElement): Promise<void> {
  if (busy) return;
  const conn = getActiveConnection();
  if (!conn) return;

  const generation = ++conn.requestGeneration;
  conn.selected = { schema, table };

  document.querySelectorAll(".table-link.active").forEach((el) => el.classList.remove("active"));
  link.classList.add("active");

  $("empty-state").hidden = true;
  $("table-panel").hidden = false;
  $("table-breadcrumb").textContent = `${conn.database} / ${schema}`;
  $("table-title").textContent = table;
  $("row-summary").textContent = "Loading structure and rows…";
  conn.currentFilter = null;
  setupFilterUI();

  setBusy(true);
  try {
    conn.metadata = await invoke<Metadata>("get_table_metadata", {
      connection: conn.config,
      request: { database: conn.database, schema, table },
    });
    if (!isCurrent(generation, conn)) return;

    $("insert-button").toggleAttribute("disabled", !conn.metadata.canMutate);
    $("insert-button").title = conn.metadata.canMutate ? "Insert a row" : "Mutations require a primary key";
    populateFilterColumns();
    await loadRows(0, generation);
  } catch (error) {
    toast(message(error), true);
    $("row-summary").textContent = message(error);
  } finally {
    setBusy(false);
  }
}

function setupFilterUI(): void {
  const filterColumn = $<HTMLSelectElement>("filter-column");
  const filterOperator = $<HTMLSelectElement>("filter-operator");
  const filterValue = $<HTMLInputElement>("filter-value");
  const filterApply = $<HTMLButtonElement>("filter-apply");
  const filterClear = $<HTMLButtonElement>("filter-clear");

  filterColumn.value = "";
  filterOperator.disabled = true;
  filterValue.disabled = true;
  filterValue.value = "";
  filterApply.disabled = true;
  filterClear.disabled = true;
}

function populateFilterColumns(): void {
  const conn = getActiveConnection();
  if (!conn || !conn.metadata) return;

  const filterColumn = $<HTMLSelectElement>("filter-column");
  empty(filterColumn);

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Filter by column...";
  filterColumn.append(defaultOption);

  for (const col of conn.metadata.columns) {
    const option = document.createElement("option");
    option.value = col.name;
    option.textContent = `${col.name} (${col.dataType})`;
    filterColumn.append(option);
  }
}

function applyFilter(): void {
  const conn = getActiveConnection();
  if (!conn || !conn.page) return;

  const filterColumn = $<HTMLSelectElement>("filter-column");
  const filterOperator = $<HTMLSelectElement>("filter-operator");
  const filterValue = $<HTMLInputElement>("filter-value");

  if (!filterColumn.value) {
    conn.currentFilter = null;
  } else {
    conn.currentFilter = {
      column: filterColumn.value,
      operator: filterOperator.value,
      value: filterValue.value,
    };
  }
  renderGrid();
}

function getFilteredRows(): RowItem[] {
  const conn = getActiveConnection();
  if (!conn || !conn.page) return [];
  if (!conn.currentFilter) return conn.page.rows;

  const { column, operator, value } = conn.currentFilter;

  return conn.page.rows.filter((item) => {
    const cellValue = item.values[column];

    if (operator === "IS NULL") return cellValue === null;
    if (operator === "IS NOT NULL") return cellValue !== null;

    if (cellValue === null || cellValue === undefined) return false;

    const cellStr = String(cellValue).toLowerCase();
    const searchStr = value.toLowerCase();

    switch (operator) {
      case "=":
        return cellStr === searchStr;
      case "!=":
        return cellStr !== searchStr;
      case ">":
        return Number(cellValue) > Number(value);
      case "<":
        return Number(cellValue) < Number(value);
      case ">=":
        return Number(cellValue) >= Number(value);
      case "<=":
        return Number(cellValue) <= Number(value);
      case "LIKE":
        return cellStr.includes(searchStr);
      case "ILIKE":
        return cellStr.includes(searchStr);
      default:
        return true;
    }
  });
}

async function loadRows(nextPage = 0, generation = currentGeneration()): Promise<void> {
  const conn = getActiveConnection();
  if (!conn || !conn.selected || !conn.metadata || !isCurrent(generation, conn)) return;

  $("row-summary").textContent = "Loading rows…";
  try {
    conn.page = await invoke<RowPage>("get_rows", {
      connection: conn.config,
      request: {
        database: conn.database,
        ...conn.selected,
        page: nextPage,
        pageSize: Number($<HTMLSelectElement>("page-size").value),
      },
    });
    if (!isCurrent(generation, conn)) return;

    renderGrid();
    updateRowSummary();
  } catch (error) {
    toast(message(error), true);
    $("row-summary").textContent = message(error);
  }
}

function renderGrid(): void {
  const conn = getActiveConnection();
  if (!conn || !conn.metadata || !conn.page) return;

  const hasActions = conn.metadata.canMutate;

  if (conn.viewMode === "tree") {
    renderTreeView(hasActions);
  } else {
    renderGridView(hasActions);
  }
}

function renderGridView(hasActions: boolean): void {
  const conn = getActiveConnection();
  if (!conn || !conn.metadata || !conn.page) return;

  grid.className = "grid";
  const widths = conn.metadata.columns.map(() => "minmax(150px, 1fr)");
  if (hasActions) widths.push("130px");
  const gridWidth = conn.metadata.columns.length * 170 + (hasActions ? 130 : 0);
  grid.style.setProperty("--grid-columns", widths.join(" "));
  grid.style.setProperty("--grid-width", `${gridWidth}px`);

  empty(gridHead);
  for (const col of conn.metadata.columns) {
    const cell = document.createElement("div");
    cell.className = "grid-cell";
    cell.role = "columnheader";
    cell.textContent = `${col.name}${col.primaryKey ? " 🔑" : ""}`;
    cell.title = `${col.dataType}${col.nullable ? ", nullable" : ""}`;
    gridHead.append(cell);
  }
  if (hasActions) {
    const cell = document.createElement("div");
    cell.className = "grid-cell";
    cell.role = "columnheader";
    cell.textContent = "Actions";
    gridHead.append(cell);
  }

  const filteredRows = getFilteredRows();
  gridSpacer.style.height = `${filteredRows.length * ROW_HEIGHT}px`;
  gridScroll.scrollTop = 0;
  lastRenderedRange = { start: -1, end: -1 };
  renderVisibleRows();
}

function renderTreeView(hasActions: boolean): void {
  const conn = getActiveConnection();
  if (!conn || !conn.metadata || !conn.page) return;

  grid.className = "grid tree-view";
  grid.style.removeProperty("--grid-columns");
  grid.style.removeProperty("--grid-width");
  empty(gridHead);
  empty(gridBody);
  gridSpacer.style.height = "0";

  const filteredRows = getFilteredRows();

  if (filteredRows.length === 0) {
    gridBody.innerHTML = '<div class="grid-message">No rows match the filter.</div>';
    return;
  }

  for (const item of filteredRows) {
    const card = document.createElement("div");
    card.className = "tree-card";

    const header = document.createElement("div");
    header.className = "tree-card-header";

    const toggle = document.createElement("button");
    toggle.className = "tree-toggle";
    toggle.type = "button";
    toggle.textContent = "▶";
    toggle.setAttribute("aria-expanded", "false");

    const pkValues = conn.metadata.columns
      .filter((c) => c.primaryKey)
      .map((c) => `${c.name}: ${displayValue(item.values[c.name] ?? null)}`)
      .join(", ");
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = pkValues || "Row";

    header.append(toggle, label);

    if (hasActions && item.rowRef) {
      const actions = document.createElement("div");
      actions.className = "tree-actions";
      actions.append(
        button("Edit", "action-button", () => openForm("edit", item)),
        button("Delete", "action-button delete", () => confirmDelete(item))
      );
      header.append(actions);
    }

    const body = document.createElement("div");
    body.className = "tree-card-body";
    body.hidden = true;

    const table = document.createElement("table");
    table.className = "tree-table";
    for (const col of conn.metadata.columns) {
      const row = document.createElement("tr");
      const keyCell = document.createElement("td");
      keyCell.className = "tree-key selectable-cell draggable-key";
      keyCell.textContent = `${col.name}${col.primaryKey ? " 🔑" : ""}`;
      keyCell.title = `${col.dataType}${col.nullable ? ", nullable" : ""}`;
      keyCell.setAttribute("data-value", col.name);
      keyCell.setAttribute("draggable", "true");

      const valueCell = document.createElement("td");
      const value = item.values[col.name] ?? null;
      valueCell.className = `tree-value${value === null ? " null" : ""}`;

      const isJsonb = col.dataType === "jsonb" && value !== null && typeof value === "object";

      if (isJsonb) {
        // JSON expansion logic (abbreviated for brevity)
        const fullText = displayValue(value);
        valueCell.textContent = fullText.length > 200 ? fullText.slice(0, 200) + "…" : fullText;
        valueCell.title = fullText;
        valueCell.classList.add("selectable-cell");
        valueCell.setAttribute("data-value", fullText);
      } else {
        const fullText = displayValue(value);
        valueCell.textContent = fullText.length > 200 ? fullText.slice(0, 200) + "…" : fullText;
        valueCell.title = fullText;
        valueCell.classList.add("selectable-cell");
        valueCell.setAttribute("data-value", fullText);
      }

      row.append(keyCell, valueCell);
      table.append(row);
    }
    body.append(table);

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.textContent = expanded ? "▶" : "▼";
      body.hidden = expanded;
    });

    card.append(header, body);
    gridBody.append(card);
  }
}

function renderVisibleRows(): void {
  const conn = getActiveConnection();
  if (!conn || !conn.metadata || !conn.page) return;

  const filteredRows = getFilteredRows();
  const start = Math.max(0, Math.floor(gridScroll.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(gridScroll.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(filteredRows.length, start + count);

  if (lastRenderedRange.start === start && lastRenderedRange.end === end) return;
  lastRenderedRange = { start, end };

  empty(gridBody);
  gridBody.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
  if (!filteredRows.length) {
    gridBody.innerHTML = '<div class="grid-message">No rows match the filter.</div>';
    return;
  }

  for (let index = start; index < end; index += 1) {
    const item = filteredRows[index]!;
    const row = document.createElement("div");
    row.className = "grid-row";
    row.role = "row";

    for (const col of conn.metadata.columns) {
      const value = item.values[col.name] ?? null;
      const cell = document.createElement("div");
      cell.className = `grid-cell${value === null ? " null" : ""}`;
      cell.role = "gridcell";
      cell.textContent = displayValue(value);
      cell.title = cell.textContent;
      row.append(cell);
    }

    if (item.rowRef) {
      const actions = document.createElement("div");
      actions.className = "grid-cell actions";
      actions.role = "gridcell";
      actions.append(
        button("Edit", "action-button", () => openForm("edit", item)),
        button("Delete", "action-button delete", () => confirmDelete(item))
      );
      row.append(actions);
    }
    gridBody.append(row);
  }
}

function displayValue(value: JsonValue): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseValue(text: string, column: ColumnInfo): JsonValue {
  if (["json", "jsonb"].includes(column.udtName)) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new Error(`${column.name} must contain valid JSON`);
    }
  }
  if (column.udtName === "bool") {
    if (!["true", "false"].includes(text)) throw new Error(`${column.name} must be true or false`);
    return text === "true";
  }
  if (["int2", "int4", "float4", "float8"].includes(column.udtName)) {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`${column.name} must be a number`);
    return value;
  }
  if (["int8", "numeric"].includes(column.udtName) && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))
    throw new Error(`${column.name} must be a valid number`);
  return text;
}

function openModal(
  title: string,
  copy: string
): { modal: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void } {
  lastFocus = document.activeElement as HTMLElement;
  const root = $("modal-root");
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("section");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const header = document.createElement("header");
  header.className = "modal-header";
  const text = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = copy;
  text.append(heading, description);
  const body = document.createElement("div");
  body.className = "modal-body";
  const footer = document.createElement("footer");
  footer.className = "modal-footer";
  const close = (): void => {
    root.replaceChildren();
    lastFocus?.focus();
  };
  const closeButton = button("×", "modal-close", close);
  closeButton.setAttribute("aria-label", "Close dialog");
  header.append(text, closeButton);
  modal.append(header, body, footer);
  backdrop.append(modal);
  root.append(backdrop);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const focusable = [
        ...modal.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled)"),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  requestAnimationFrame(() => (modal.querySelector("input,textarea,button") as HTMLElement | null)?.focus());
  return { modal, body, footer, close };
}

function openForm(mode: "insert" | "edit", item?: RowItem): void {
  const conn = getActiveConnection();
  if (!conn || !conn.metadata || !conn.selected) return;

  const dialog = openModal(
    mode === "insert" ? "New row" : "Edit row",
    `${conn.selected.schema}.${conn.selected.table} · JSON values are validated before saving.`
  );
  const form = document.createElement("form");
  const fields = new Map<
    string,
    { input: HTMLInputElement | HTMLTextAreaElement; nullButton: HTMLButtonElement; included: boolean }
  >();

  for (const column of conn.metadata.columns) {
    if (column.generated || (mode === "edit" && column.primaryKey)) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "form-field";
    const label = document.createElement("label");
    label.textContent = column.name;
    const meta = document.createElement("span");
    meta.className = "field-meta";
    meta.textContent = `${column.dataType}${column.primaryKey ? " · primary key" : ""}${column.hasDefault ? " · default available" : ""}`;
    label.append(" ", meta);
    const row = document.createElement("div");
    row.className = "input-row";
    const input = ["text", "varchar", "bpchar", "json", "jsonb"].includes(column.udtName)
      ? document.createElement("textarea")
      : document.createElement("input");
    input.name = column.name;
    const existing = item?.values[column.name];
    if (existing !== undefined && existing !== null)
      input.value = typeof existing === "object" ? JSON.stringify(existing, null, 2) : String(existing);
    let included = mode === "edit" || (!column.hasDefault && !column.nullable);
    const nullButton = button("NULL", "null-button", () => {
      const isNull = !input.disabled;
      input.disabled = isNull;
      nullButton.classList.toggle("active", isNull);
      nullButton.setAttribute("aria-pressed", String(isNull));
      included = true;
    });
    nullButton.hidden = !column.nullable;
    nullButton.setAttribute("aria-pressed", "false");
    if (existing === null && mode === "edit") {
      input.disabled = true;
      nullButton.classList.add("active");
      nullButton.setAttribute("aria-pressed", "true");
    }
    input.addEventListener("input", () => {
      included = true;
    });
    row.append(input, nullButton);
    wrapper.append(label, row);
    form.append(wrapper);
    fields.set(column.name, {
      input,
      nullButton,
      get included() {
        return included;
      },
      set included(value: boolean) {
        included = value;
      },
    });
  }
  dialog.body.append(form);
  dialog.footer.append(button("Cancel", "quiet-button", dialog.close));
  const save = button(mode === "insert" ? "Insert row" : "Save changes", "primary-button", async () => {
    try {
      const values: Record<string, JsonValue> = {};
      for (const column of conn.metadata!.columns) {
        const field = fields.get(column.name);
        if (!field || !field.included) continue;
        values[column.name] = field.input.disabled ? null : parseValue(field.input.value, column);
      }
      save.disabled = true;
      if (mode === "insert")
        await invoke("insert_row", { connection: conn.config, request: { database: conn.database, ...conn.selected!, values } });
      else await invoke("update_row", { connection: conn.config, request: { rowRef: item!.rowRef, values } });
      dialog.close();
      toast(mode === "insert" ? "Row inserted" : "Row updated");
      await loadRows();
    } catch (error) {
      toast(message(error), true);
      save.disabled = false;
    }
  });
  dialog.footer.append(save);
}

function confirmDelete(item: RowItem): void {
  const conn = getActiveConnection();
  if (!conn) return;
  const dialog = openModal("Delete row?", "This action cannot be undone.");
  const copy = document.createElement("p");
  copy.className = "confirm-copy";
  copy.textContent = "The row identified by its primary key will be permanently deleted.";
  dialog.body.append(copy);
  dialog.footer.append(button("Cancel", "quiet-button", dialog.close));
  const remove = button("Delete row", "danger-button", async () => {
    try {
      remove.disabled = true;
      await invoke("delete_row", { connection: conn.config, request: { rowRef: item.rowRef, confirmed: true } });
      dialog.close();
      toast("Row deleted");
      await loadRows();
    } catch (error) {
      toast(message(error), true);
      remove.disabled = false;
    }
  });
  dialog.footer.append(remove);
}

// Event listeners
gridScroll.addEventListener(
  "scroll",
  () => {
    const conn = getActiveConnection();
    if (conn && conn.viewMode === "grid") {
      renderVisibleRows();
    }
  },
  { passive: true }
);

dbSelect.addEventListener("change", async () => {
  const conn = getActiveConnection();
  if (!conn) return;
  conn.database = dbSelect.value;
  await loadTree();
});

$("refresh-button").addEventListener("click", loadTree);
$("reload-rows-button").addEventListener("click", () => loadRows());
$("insert-button").addEventListener("click", () => openForm("insert"));
$<HTMLSelectElement>("page-size").addEventListener("change", () => loadRows(0));
$("prev-page").addEventListener("click", () => {
  const conn = getActiveConnection();
  if (conn && conn.page) loadRows(Math.max(0, conn.page.page - 1));
});
$("next-page").addEventListener("click", () => {
  const conn = getActiveConnection();
  if (conn && conn.page) loadRows(conn.page.page + 1);
});
$("view-toggle").addEventListener("click", () => {
  const conn = getActiveConnection();
  if (!conn) return;
  conn.viewMode = conn.viewMode === "grid" ? "tree" : "grid";
  $("view-mode-label").textContent = conn.viewMode === "grid" ? "Grid View" : "Tree View";
  renderGrid();
});

$<HTMLSelectElement>("filter-column").addEventListener("change", (e) => {
  const column = (e.target as HTMLSelectElement).value;
  const filterOperator = $<HTMLSelectElement>("filter-operator");
  const filterValue = $<HTMLInputElement>("filter-value");
  const filterApply = $<HTMLButtonElement>("filter-apply");
  const filterClear = $<HTMLButtonElement>("filter-clear");

  if (column) {
    filterOperator.disabled = false;
    filterValue.disabled = false;
    filterApply.disabled = false;
    filterClear.disabled = false;
  } else {
    filterOperator.disabled = true;
    filterValue.disabled = true;
    filterApply.disabled = true;
    filterClear.disabled = true;
    const conn = getActiveConnection();
    if (conn) {
      conn.currentFilter = null;
      renderGrid();
    }
  }
});

$<HTMLSelectElement>("filter-operator").addEventListener("change", (e) => {
  const operator = (e.target as HTMLSelectElement).value;
  const filterValue = $<HTMLInputElement>("filter-value");
  filterValue.disabled = operator === "IS NULL" || operator === "IS NOT NULL";
});

$("filter-apply").addEventListener("click", applyFilter);
$("filter-clear").addEventListener("click", () => {
  $<HTMLSelectElement>("filter-column").value = "";
  $<HTMLSelectElement>("filter-operator").disabled = true;
  $<HTMLInputElement>("filter-value").disabled = true;
  $<HTMLInputElement>("filter-value").value = "";
  $<HTMLButtonElement>("filter-apply").disabled = true;
  $<HTMLButtonElement>("filter-clear").disabled = true;
  const conn = getActiveConnection();
  if (conn) {
    conn.currentFilter = null;
    renderGrid();
  }
});

$<HTMLInputElement>("filter-value").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyFilter();
});

newConnectionButton.addEventListener("click", () => openConnectionDialog());

async function start(): Promise<void> {
  try {
    const stored = loadConnections(localStorage);
    savedConnections = stored ?? [];
    for (const config of stored ?? [null]) {
      try {
        await createConnection(config, undefined, true);
      } catch (error) {
        toast(`${connectionLabel(config)}: ${message(error)} Click its tab to reconnect.`, true);
      }
    }
    if (!getActiveConnection()) renderConnectionState();
  } catch (error) {
    status.textContent = message(error);
    status.className = "connection-status error";
    tree.innerHTML = '<p class="tree-message">Click "New Connection" to connect to PostgreSQL.</p>';
  }
}

void start();
