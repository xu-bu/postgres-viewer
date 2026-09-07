import { invoke } from "@tauri-apps/api/core";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type SchemaInfo = { name: string; tables: { name: string; tableType: string }[] };
type ColumnInfo = { name: string; dataType: string; udtName: string; nullable: boolean; hasDefault: boolean; generated: boolean; primaryKey: boolean; ordinal: number };
type Metadata = { schema: string; table: string; columns: ColumnInfo[]; canMutate: boolean };
type RowItem = { values: Record<string, JsonValue>; rowRef: string | null };
type RowPage = { rows: RowItem[]; page: number; pageSize: number; total: number; pageCount: number };
type ConnectionInfo = { server: string; currentDatabase: string; databases: string[] };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dbSelect = $<HTMLSelectElement>("database-select");
const status = $("connection-status");
const tree = $("schema-tree");
const grid = $("grid");
const gridHead = $("grid-head");
const gridScroll = $("grid-scroll");
const gridSpacer = $("grid-spacer");
const gridBody = $("grid-body");
const ROW_HEIGHT = 39;
const OVERSCAN = 8;
let database = "";
let selected: { schema: string; table: string } | null = null;
let metadata: Metadata | null = null;
let page: RowPage | null = null;
let busy = false;
let lastFocus: HTMLElement | null = null;
let requestGeneration = 0;
let viewMode: "grid" | "tree" = "tree";
let lastRenderedRange = { start: -1, end: -1 };
let currentFilter: { column: string; operator: string; value: string } | null = null;

function currentGeneration(): number { return requestGeneration; }
function isCurrent(generation: number): boolean { return generation === requestGeneration; }

function message(error: unknown): string { return typeof error === "string" ? error : error instanceof Error ? error.message : "Unexpected error"; }
function setBusy(value: boolean): void { busy = value; document.body.toggleAttribute("aria-busy", value); }
function toast(text: string, error = false): void { const item = document.createElement("div"); item.className = `toast${error ? " error" : ""}`; item.textContent = text; $("toast-region").append(item); window.setTimeout(() => item.remove(), 4500); }
function empty(element: Element): void { element.replaceChildren(); }
function button(text: string, className: string, action: () => void): HTMLButtonElement { const el = document.createElement("button"); el.type = "button"; el.className = className; el.textContent = text; el.addEventListener("click", action); return el; }

async function start(): Promise<void> {
  try {
    const info = await invoke<ConnectionInfo>("connect_server");
    database = info.currentDatabase;

    // Try to restore last session
    const lastSession = localStorage.getItem("postgresui_last_session");
    if (lastSession) {
      try {
        const session = JSON.parse(lastSession);
        if (session.database && info.databases.includes(session.database)) {
          database = session.database;
        }
      } catch {}
    }

    empty(dbSelect);
    for (const name of info.databases) { const option = document.createElement("option"); option.value = name; option.textContent = name; option.selected = name === database; dbSelect.append(option); }
    dbSelect.disabled = false;
    status.textContent = `Connected to ${info.server}`;
    status.className = "connection-status connected";
    await loadTree();

    // After tree is loaded, try to restore last table
    if (lastSession) {
      try {
        const session = JSON.parse(lastSession);
        if (session.schema && session.table) {
          // Find and click the table link
          const tableLink = Array.from(document.querySelectorAll(".table-link")).find(link => {
            const btn = link as HTMLButtonElement;
            return btn.dataset.schema === session.schema && btn.dataset.table === session.table;
          }) as HTMLButtonElement | undefined;
          if (tableLink) {
            tableLink.click();
          }
        }
      } catch {}
    }
  } catch (error) {
    status.textContent = message(error);
    status.className = "connection-status error";
    tree.innerHTML = '<p class="tree-message">Check your PostgreSQL environment settings, then restart the app.</p>';
  }
}

async function loadTree(): Promise<void> {
  const generation = ++requestGeneration;
  selected = null; metadata = null; page = null;
  $("empty-state").hidden = false; $("table-panel").hidden = true;
  empty(tree); const loading = document.createElement("p"); loading.className = "tree-message"; loading.textContent = "Loading schemas…"; tree.append(loading);
  try {
    const schemas = await invoke<SchemaInfo[]>("list_schemas", { database });
    if (!isCurrent(generation)) return;
    empty(tree);
    if (!schemas.length) { const emptyMessage = document.createElement("p"); emptyMessage.className = "tree-message"; emptyMessage.textContent = "No visible tables."; tree.append(emptyMessage); return; }
    for (const schema of schemas) {
      const group = document.createElement("section");
      const list = document.createElement("ul"); list.className = "table-list";
      const toggle = button("", "schema-toggle", () => { const collapsed = toggle.getAttribute("aria-expanded") === "false"; toggle.setAttribute("aria-expanded", String(collapsed)); list.hidden = !collapsed; });
      toggle.setAttribute("aria-expanded", "true");
      const caret = document.createElement("span"); caret.className = "schema-caret"; caret.textContent = "▾";
      const label = document.createElement("span"); label.textContent = schema.name;
      toggle.append(caret, label);
      for (const table of schema.tables) { const li = document.createElement("li"); const link = button(table.name, "table-link", () => selectTable(schema.name, table.name, link)); link.title = `${table.tableType}: ${schema.name}.${table.name}`; link.dataset.schema = schema.name; link.dataset.table = table.name; li.append(link); list.append(li); }
      group.append(toggle, list); tree.append(group);
    }
  } catch (error) { if (!isCurrent(generation)) return; empty(tree); const errorMessage = document.createElement("p"); errorMessage.className = "tree-message"; errorMessage.textContent = message(error); tree.append(errorMessage); toast(message(error), true); }
}

async function selectTable(schema: string, table: string, link: HTMLButtonElement): Promise<void> {
  if (busy) return;
  const generation = ++requestGeneration;
  selected = { schema, table }; document.querySelectorAll(".table-link.active").forEach((el) => el.classList.remove("active")); link.classList.add("active");
  $("empty-state").hidden = true; $("table-panel").hidden = false;
  $("table-breadcrumb").textContent = `${database} / ${schema}`; $("table-title").textContent = table;
  $("row-summary").textContent = "Loading structure and rows…";
  currentFilter = null;
  setupFilterUI();

  // Save session
  localStorage.setItem("postgresui_last_session", JSON.stringify({ database, schema, table }));

  setBusy(true);
  try {
    metadata = await invoke<Metadata>("get_table_metadata", { request: { database, schema, table } });
    if (!isCurrent(generation)) return;
    $("insert-button").toggleAttribute("disabled", !metadata.canMutate);
    $("insert-button").title = metadata.canMutate ? "Insert a row" : "Mutations require a primary key";
    populateFilterColumns();
    await loadRows(0, generation);
  } catch (error) { toast(message(error), true); $("row-summary").textContent = message(error); }
  finally { setBusy(false); }
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
  if (!metadata) return;
  const filterColumn = $<HTMLSelectElement>("filter-column");
  empty(filterColumn);
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Filter by column...";
  filterColumn.append(defaultOption);
  for (const col of metadata.columns) {
    const option = document.createElement("option");
    option.value = col.name;
    option.textContent = `${col.name} (${col.dataType})`;
    filterColumn.append(option);
  }
}

function applyFilter(): void {
  if (!page) return;
  const filterColumn = $<HTMLSelectElement>("filter-column");
  const filterOperator = $<HTMLSelectElement>("filter-operator");
  const filterValue = $<HTMLInputElement>("filter-value");

  if (!filterColumn.value) {
    currentFilter = null;
  } else {
    currentFilter = {
      column: filterColumn.value,
      operator: filterOperator.value,
      value: filterValue.value
    };
  }
  renderGrid();
}

function getFilteredRows(): RowItem[] {
  if (!page) return [];
  if (!currentFilter) return page.rows;

  const { column, operator, value } = currentFilter;

  return page.rows.filter(item => {
    const cellValue = item.values[column];

    if (operator === "IS NULL") return cellValue === null;
    if (operator === "IS NOT NULL") return cellValue !== null;

    if (cellValue === null || cellValue === undefined) return false;

    const cellStr = String(cellValue).toLowerCase();
    const searchStr = value.toLowerCase();

    switch (operator) {
      case "=": return cellStr === searchStr;
      case "!=": return cellStr !== searchStr;
      case ">": return Number(cellValue) > Number(value);
      case "<": return Number(cellValue) < Number(value);
      case ">=": return Number(cellValue) >= Number(value);
      case "<=": return Number(cellValue) <= Number(value);
      case "LIKE": return cellStr.includes(searchStr);
      case "ILIKE": return cellStr.includes(searchStr);
      default: return true;
    }
  });
}

async function loadRows(nextPage = page?.page ?? 0, generation = currentGeneration()): Promise<void> {
  if (!selected || !metadata || !isCurrent(generation)) return;
  $("row-summary").textContent = "Loading rows…";
  try {
    page = await invoke<RowPage>("get_rows", { request: { database, ...selected, page: nextPage, pageSize: Number($<HTMLSelectElement>("page-size").value) } });
    if (!isCurrent(generation)) return;
    renderGrid();
    const first = page.total ? page.page * page.pageSize + 1 : 0;
    const last = Math.min(page.total, (page.page + 1) * page.pageSize);
    $("row-summary").textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${page.total.toLocaleString()} rows${metadata.canMutate ? "" : " · read only (no primary key)"}`;
    $("page-label").textContent = page.pageCount ? `Page ${page.page + 1} of ${page.pageCount}` : "No pages";
    $<HTMLButtonElement>("prev-page").disabled = page.page === 0;
    $<HTMLButtonElement>("next-page").disabled = page.page + 1 >= page.pageCount;
  } catch (error) { toast(message(error), true); $("row-summary").textContent = message(error); }
}

function renderGrid(): void {
  if (!metadata || !page) return;
  const hasActions = metadata.canMutate;

  if (viewMode === "tree") {
    renderTreeView(hasActions);
  } else {
    renderGridView(hasActions);
  }
}

function renderGridView(hasActions: boolean): void {
  if (!metadata || !page) return;
  grid.className = "grid";
  const widths = metadata.columns.map(() => "minmax(150px, 1fr)"); if (hasActions) widths.push("130px");
  const gridWidth = metadata.columns.length * 170 + (hasActions ? 130 : 0);
  grid.style.setProperty("--grid-columns", widths.join(" ")); grid.style.setProperty("--grid-width", `${gridWidth}px`);
  empty(gridHead);
  for (const col of metadata.columns) { const cell = document.createElement("div"); cell.className = "grid-cell"; cell.role = "columnheader"; cell.textContent = `${col.name}${col.primaryKey ? " 🔑" : ""}`; cell.title = `${col.dataType}${col.nullable ? ", nullable" : ""}`; gridHead.append(cell); }
  if (hasActions) { const cell = document.createElement("div"); cell.className = "grid-cell"; cell.role = "columnheader"; cell.textContent = "Actions"; gridHead.append(cell); }
  const filteredRows = getFilteredRows();
  gridSpacer.style.height = `${filteredRows.length * ROW_HEIGHT}px`; gridScroll.scrollTop = 0; lastRenderedRange = { start: -1, end: -1 }; renderVisibleRows();
}

function renderTreeView(hasActions: boolean): void {
  if (!metadata || !page) return;

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

    const pkValues = metadata.columns.filter(c => c.primaryKey).map(c => `${c.name}: ${displayValue(item.values[c.name] ?? null)}`).join(", ");
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
    for (const col of metadata.columns) {
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

      // Check if this is a JSONB field with an object or array value
      const isJsonb = col.dataType === "jsonb" && value !== null && typeof value === "object";

      if (isJsonb) {
        // Create expandable JSON view with toggle
        const jsonToggle = document.createElement("button");
        jsonToggle.className = "json-toggle";
        jsonToggle.type = "button";
        jsonToggle.textContent = "▶";
        jsonToggle.title = "Expand JSON";

        const jsonPreview = document.createElement("span");
        jsonPreview.className = "json-preview selectable-cell";
        const fullText = displayValue(value);
        jsonPreview.textContent = fullText.length > 100 ? fullText.slice(0, 100) + "…" : fullText;
        jsonPreview.setAttribute("data-value", fullText);

        valueCell.append(jsonToggle, jsonPreview);

        // Create nested table for expanded JSON fields (initially hidden)
        const nestedContainer = document.createElement("div");
        nestedContainer.className = "json-nested-container";
        nestedContainer.hidden = true;

        const nestedTable = document.createElement("table");
        nestedTable.className = "tree-table json-nested-table";

        const renderJsonFields = (obj: any, prefix = "") => {
          if (obj === null || obj === undefined) return;

          if (Array.isArray(obj)) {
            // Limit array rendering to first 50 items for performance
            const itemsToShow = Math.min(obj.length, 50);
            for (let index = 0; index < itemsToShow; index++) {
              const item = obj[index];
              const nestedRow = document.createElement("tr");
              const nestedKey = document.createElement("td");
              nestedKey.className = "tree-key json-nested-key selectable-cell draggable-key";
              const keyPath = `${prefix}[${index}]`;
              nestedKey.textContent = keyPath;
              nestedKey.setAttribute("data-value", keyPath);
              nestedKey.setAttribute("draggable", "true");

              const nestedValue = document.createElement("td");
              nestedValue.className = "tree-value selectable-cell";
              const itemText = typeof item === "object" ? JSON.stringify(item) : String(item);
              // Truncate very long values
              const displayText = itemText.length > 500 ? itemText.slice(0, 500) + "…" : itemText;
              nestedValue.textContent = displayText;
              nestedValue.setAttribute("data-value", itemText);

              nestedRow.append(nestedKey, nestedValue);
              nestedTable.append(nestedRow);
            }

            // Show count if array was truncated
            if (obj.length > itemsToShow) {
              const truncRow = document.createElement("tr");
              const truncCell = document.createElement("td");
              truncCell.colSpan = 2;
              truncCell.className = "json-truncated-notice";
              truncCell.textContent = `… and ${obj.length - itemsToShow} more items`;
              truncRow.append(truncCell);
              nestedTable.append(truncRow);
            }
          } else if (typeof obj === "object") {
            const entries = Object.entries(obj);
            // Limit object fields to first 50 for performance
            const entriesToShow = entries.slice(0, 50);

            entriesToShow.forEach(([key, val]) => {
              const nestedRow = document.createElement("tr");
              const nestedKey = document.createElement("td");
              nestedKey.className = "tree-key json-nested-key selectable-cell draggable-key";
              const keyPath = prefix ? `${prefix}.${key}` : key;
              nestedKey.textContent = keyPath;
              nestedKey.setAttribute("data-value", keyPath);
              nestedKey.setAttribute("draggable", "true");

              const nestedValue = document.createElement("td");
              nestedValue.className = "tree-value selectable-cell";
              const valText = typeof val === "object" ? JSON.stringify(val) : String(val);
              // Truncate very long values
              const displayText = valText.length > 500 ? valText.slice(0, 500) + "…" : valText;
              nestedValue.textContent = displayText;
              nestedValue.setAttribute("data-value", valText);

              nestedRow.append(nestedKey, nestedValue);
              nestedTable.append(nestedRow);
            });

            // Show count if object was truncated
            if (entries.length > entriesToShow.length) {
              const truncRow = document.createElement("tr");
              const truncCell = document.createElement("td");
              truncCell.colSpan = 2;
              truncCell.className = "json-truncated-notice";
              truncCell.textContent = `… and ${entries.length - entriesToShow.length} more fields`;
              truncRow.append(truncCell);
              nestedTable.append(truncRow);
            }
          }
        };

        renderJsonFields(value);
        nestedContainer.append(nestedTable);
        valueCell.append(nestedContainer);

        // Toggle expand/collapse
        jsonToggle.addEventListener("click", (e) => {
          e.stopPropagation();
          const isExpanded = jsonToggle.textContent === "▼";
          jsonToggle.textContent = isExpanded ? "▶" : "▼";
          nestedContainer.hidden = isExpanded;
        });
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

    // Add cell selection and copy functionality
    body.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("selectable-cell")) {
        // Remove previous selection
        body.querySelectorAll(".selectable-cell.selected").forEach(el => el.classList.remove("selected"));
        // Mark this cell as selected
        target.classList.add("selected");
        target.focus();
      }
    });

    body.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const selected = body.querySelector(".selectable-cell.selected") as HTMLElement;
        if (selected) {
          const textToCopy = selected.getAttribute("data-value") || selected.textContent || "";
          navigator.clipboard.writeText(textToCopy).then(() => {
            // Visual feedback
            const originalBg = selected.style.background;
            selected.style.background = "var(--accent-soft)";
            setTimeout(() => { selected.style.background = originalBg; }, 200);
          }).catch(err => console.error("Copy failed:", err));
        }
      }
    });

    // Add drag handlers for field names
    body.addEventListener("dragstart", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("draggable-key")) {
        const fieldName = target.getAttribute("data-value") || target.textContent || "";
        e.dataTransfer!.effectAllowed = "copy";
        e.dataTransfer!.setData("text/plain", fieldName);
        target.style.opacity = "0.5";
      }
    });

    body.addEventListener("dragend", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("draggable-key")) {
        target.style.opacity = "";
      }
    });

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
  if (!metadata || !page) return;
  const filteredRows = getFilteredRows();
  const start = Math.max(0, Math.floor(gridScroll.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(gridScroll.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(filteredRows.length, start + count);

  // Skip re-render if the range hasn't changed
  if (lastRenderedRange.start === start && lastRenderedRange.end === end) return;
  lastRenderedRange = { start, end };

  empty(gridBody); gridBody.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
  if (!filteredRows.length) { gridBody.innerHTML = '<div class="grid-message">No rows match the filter.</div>'; return; }
  for (let index = start; index < end; index += 1) {
    const item = filteredRows[index]!; const row = document.createElement("div"); row.className = "grid-row"; row.role = "row";
    for (const col of metadata.columns) { const value = item.values[col.name] ?? null; const cell = document.createElement("div"); cell.className = `grid-cell${value === null ? " null" : ""}`; cell.role = "gridcell"; cell.textContent = displayValue(value); cell.title = cell.textContent; row.append(cell); }
    if (item.rowRef) { const actions = document.createElement("div"); actions.className = "grid-cell actions"; actions.role = "gridcell"; actions.append(button("Edit", "action-button", () => openForm("edit", item)), button("Delete", "action-button delete", () => confirmDelete(item))); row.append(actions); }
    gridBody.append(row);
  }
}

function displayValue(value: JsonValue): string { if (value === null) return "NULL"; if (typeof value === "object") return JSON.stringify(value); return String(value); }
function parseValue(text: string, column: ColumnInfo): JsonValue {
  if (["json", "jsonb"].includes(column.udtName)) { try { return JSON.parse(text) as JsonValue; } catch { throw new Error(`${column.name} must contain valid JSON`); } }
  if (column.udtName === "bool") { if (!["true", "false"].includes(text)) throw new Error(`${column.name} must be true or false`); return text === "true"; }
  if (["int2", "int4", "float4", "float8"].includes(column.udtName)) { const value = Number(text); if (!Number.isFinite(value)) throw new Error(`${column.name} must be a number`); return value; }
  if (["int8", "numeric"].includes(column.udtName) && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error(`${column.name} must be a valid number`);
  return text;
}

function openModal(title: string, copy: string): { modal: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void } {
  lastFocus = document.activeElement as HTMLElement;
  const root = $("modal-root"); const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop";
  const modal = document.createElement("section"); modal.className = "modal"; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  const header = document.createElement("header"); header.className = "modal-header"; const text = document.createElement("div"); const heading = document.createElement("h2"); heading.textContent = title; const description = document.createElement("p"); description.textContent = copy; text.append(heading, description);
  const body = document.createElement("div"); body.className = "modal-body"; const footer = document.createElement("footer"); footer.className = "modal-footer";
  const close = (): void => { root.replaceChildren(); lastFocus?.focus(); };
  const closeButton = button("×", "modal-close", close); closeButton.setAttribute("aria-label", "Close dialog"); header.append(text, closeButton); modal.append(header, body, footer); backdrop.append(modal); root.append(backdrop);
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) close(); });
  modal.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); if (event.key === "Tab") { const focusable = [...modal.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled)")]; const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } });
  requestAnimationFrame(() => (modal.querySelector("input,textarea,button") as HTMLElement | null)?.focus());
  return { modal, body, footer, close };
}

function openForm(mode: "insert" | "edit", item?: RowItem): void {
  if (!metadata || !selected) return;
  const dialog = openModal(mode === "insert" ? "New row" : "Edit row", `${selected.schema}.${selected.table} · JSON values are validated before saving.`);
  const form = document.createElement("form"); const fields = new Map<string, { input: HTMLInputElement | HTMLTextAreaElement; nullButton: HTMLButtonElement; included: boolean }>();
  for (const column of metadata.columns) {
    if (column.generated || (mode === "edit" && column.primaryKey)) continue;
    const wrapper = document.createElement("div"); wrapper.className = "form-field";
    const label = document.createElement("label"); label.textContent = column.name; const meta = document.createElement("span"); meta.className = "field-meta"; meta.textContent = `${column.dataType}${column.primaryKey ? " · primary key" : ""}${column.hasDefault ? " · default available" : ""}`; label.append(" ", meta);
    const row = document.createElement("div"); row.className = "input-row";
    const input = ["text", "varchar", "bpchar", "json", "jsonb"].includes(column.udtName) ? document.createElement("textarea") : document.createElement("input");
    input.name = column.name; const existing = item?.values[column.name]; if (existing !== undefined && existing !== null) input.value = typeof existing === "object" ? JSON.stringify(existing, null, 2) : String(existing);
    let included = mode === "edit" || (!column.hasDefault && !column.nullable);
    const nullButton = button("NULL", "null-button", () => { const isNull = !input.disabled; input.disabled = isNull; nullButton.classList.toggle("active", isNull); nullButton.setAttribute("aria-pressed", String(isNull)); included = true; });
    nullButton.hidden = !column.nullable; nullButton.setAttribute("aria-pressed", "false");
    if (existing === null && mode === "edit") { input.disabled = true; nullButton.classList.add("active"); nullButton.setAttribute("aria-pressed", "true"); }
    input.addEventListener("input", () => { included = true; }); row.append(input, nullButton); wrapper.append(label, row); form.append(wrapper); fields.set(column.name, { input, nullButton, get included() { return included; }, set included(value: boolean) { included = value; } });
  }
  dialog.body.append(form); dialog.footer.append(button("Cancel", "quiet-button", dialog.close)); const save = button(mode === "insert" ? "Insert row" : "Save changes", "primary-button", async () => {
    try {
      const values: Record<string, JsonValue> = {};
      for (const column of metadata!.columns) { const field = fields.get(column.name); if (!field || !field.included) continue; values[column.name] = field.input.disabled ? null : parseValue(field.input.value, column); }
      save.disabled = true;
      if (mode === "insert") await invoke("insert_row", { request: { database, ...selected!, values } });
      else await invoke("update_row", { request: { rowRef: item!.rowRef, values } });
      dialog.close(); toast(mode === "insert" ? "Row inserted" : "Row updated"); await loadRows();
    } catch (error) { toast(message(error), true); save.disabled = false; }
  }); dialog.footer.append(save);
}

function confirmDelete(item: RowItem): void {
  const dialog = openModal("Delete row?", "This action cannot be undone."); const copy = document.createElement("p"); copy.className = "confirm-copy"; copy.textContent = "The row identified by its primary key will be permanently deleted."; dialog.body.append(copy); dialog.footer.append(button("Cancel", "quiet-button", dialog.close));
  const remove = button("Delete row", "danger-button", async () => { try { remove.disabled = true; await invoke("delete_row", { request: { rowRef: item.rowRef, confirmed: true } }); dialog.close(); toast("Row deleted"); await loadRows(); } catch (error) { toast(message(error), true); remove.disabled = false; } }); dialog.footer.append(remove);
}

gridScroll.addEventListener("scroll", () => {
  if (viewMode === "grid") {
    renderVisibleRows();
  }
}, { passive: true });
dbSelect.addEventListener("change", async () => {
  database = dbSelect.value;
  localStorage.setItem("postgresui_last_session", JSON.stringify({ database, schema: null, table: null }));
  await loadTree();
});
$("refresh-button").addEventListener("click", loadTree);
$("reload-rows-button").addEventListener("click", () => loadRows());
$("insert-button").addEventListener("click", () => openForm("insert"));
$<HTMLSelectElement>("page-size").addEventListener("change", () => loadRows(0));
$("prev-page").addEventListener("click", () => loadRows(Math.max(0, (page?.page ?? 0) - 1)));
$("next-page").addEventListener("click", () => loadRows((page?.page ?? 0) + 1));
$("view-toggle").addEventListener("click", () => {
  viewMode = viewMode === "grid" ? "tree" : "grid";
  $("view-mode-label").textContent = viewMode === "grid" ? "Grid View" : "Tree View";
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
    currentFilter = null;
    renderGrid();
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
  currentFilter = null;
  renderGrid();
});

$<HTMLInputElement>("filter-value").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyFilter();
});

// Add drop target handlers for filter column
const filterColumnSelect = $<HTMLSelectElement>("filter-column");

filterColumnSelect.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  filterColumnSelect.style.background = "var(--accent-soft)";
});

filterColumnSelect.addEventListener("dragleave", () => {
  filterColumnSelect.style.background = "";
});

filterColumnSelect.addEventListener("drop", (e) => {
  e.preventDefault();
  filterColumnSelect.style.background = "";

  const fieldName = e.dataTransfer!.getData("text/plain");
  if (fieldName) {
    // Check if this field exists in the column options
    const option = Array.from(filterColumnSelect.options).find(opt => opt.value === fieldName);

    if (option) {
      // Select the column
      filterColumnSelect.value = fieldName;

      // Enable the operator and value inputs
      const filterOperator = $<HTMLSelectElement>("filter-operator");
      const filterValue = $<HTMLInputElement>("filter-value");

      filterOperator.disabled = false;
      filterValue.disabled = false;

      // Focus on the value input for easy typing
      filterValue.focus();

      toast(`Filter column set to: ${fieldName}`);
    } else {
      toast(`Field "${fieldName}" not found in columns`, true);
    }
  }
});

void start();
