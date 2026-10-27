'use strict';

/**
 * 通用数据表格组件
 *
 * 用法：
 *   const tbl = new DataTable({
 *     mount: document.getElementById('product-list'),
 *     columns: [
 *       { key: 'title', label: '商品', width: 'auto', sortable: true,
 *         render: (row) => `<div class="cell-title">${row.title}</div>` },
 *       { key: 'price', label: '价格', width: '100px', align: 'right', sortable: true,
 *         render: (row) => `<span class="cell-price">￥${row.price}</span>` },
 *     ],
 *     fetch: async ({ page, pageSize, sortKey, sortDir }) => { ... return { list, total } },
 *     rowKey: (row) => row.item_id,
 *     batchActions: [{ label: '批量下架', onClick: (rows) => {} }],
 *     onRowClick: (row) => {},
 *     pageSizeOptions: [20, 50, 100],
 *     emptyText: '还没有数据',
 *   });
 *   await tbl.reload();
 *
 * 功能：
 *   - 表头排序
 *   - 全选 / 单选 / 批量操作栏
 *   - 分页
 *   - 列显示/隐藏（⚙）
 *   - 加载骨架屏
 *   - 空状态
 */

(function () {
  class DataTable {
    constructor(opt) {
      this.opt = opt;
      this.mount = opt.mount;
      this.columns = opt.columns || [];
      this.page = 1;
      this.pageSize = (opt.pageSizeOptions && opt.pageSizeOptions[0]) || 20;
      this.sortKey = null;
      this.sortDir = null;
      this.selected = new Set();
      this.list = [];
      this.total = 0;
      this.loading = false;
      this.hiddenCols = new Set();
      this._renderShell();
    }

    _rowKey(row) {
      return String(this.opt.rowKey(row));
    }

    /* ---------------- 骨架 ---------------- */
    _renderShell() {
      const m = this.mount;
      m.innerHTML = `
        <div class="tbl-wrap" style="position:relative">
          <div class="tbl-toolbar">
            <div class="left">
              <span class="tbl-title">${this.opt.title || ''}</span>
              <span class="tbl-sub" data-role="sub"></span>
            </div>
            <div class="right">
              ${(this.opt.toolbarButtons || []).map((b, i) =>
                `<button class="tbl-tool-btn" data-tool="${i}" title="${b.title || ''}">${b.icon || ''}</button>`).join('')}
              <button class="tbl-tool-btn" data-role="colset" title="列设置" aria-label="列设置">${window.UI.icon('columns')}</button>
            </div>
          </div>
          <div class="batch-bar" data-role="batch"></div>
          <div class="tbl-scroll">
            <table class="dt">
              <thead data-role="head"></thead>
              <tbody data-role="body"></tbody>
            </table>
          </div>
          <div class="tbl-pager" data-role="pager"></div>
          <div class="colset-pop" data-role="colset-pop"></div>
        </div>
      `;

      // 工具按钮
      (this.opt.toolbarButtons || []).forEach((b, i) => {
        const btn = m.querySelector(`[data-tool="${i}"]`);
        if (btn) btn.onclick = () => b.onClick && b.onClick(this);
      });

      // 列设置
      const pop = m.querySelector('[data-role="colset-pop"]');
      m.querySelector('[data-role="colset"]').onclick = (e) => {
        e.stopPropagation();
        pop.classList.toggle('show');
        if (pop.classList.contains('show')) this._renderColset();
      };
      document.addEventListener('click', () => pop.classList.remove('show'));

      this.el = {
        head: m.querySelector('[data-role="head"]'),
        body: m.querySelector('[data-role="body"]'),
        pager: m.querySelector('[data-role="pager"]'),
        batch: m.querySelector('[data-role="batch"]'),
        sub: m.querySelector('[data-role="sub"]'),
      };
    }

    _renderColset() {
      const pop = this.mount.querySelector('[data-role="colset-pop"]');
      const toggleable = this.columns.filter((c) => c.key !== '_check');
      pop.innerHTML = '<div style="font-size:11px;color:#8b93a1;padding:4px 8px 6px">显示列</div>'
        + toggleable.map((c) =>
          `<label><input type="checkbox" data-col="${c.key}" ${this.hiddenCols.has(c.key) ? '' : 'checked'} /> ${c.label}</label>`,
        ).join('');
      pop.querySelectorAll('input[data-col]').forEach((inp) => {
        inp.onchange = () => {
          const k = inp.dataset.col;
          if (inp.checked) this.hiddenCols.delete(k);
          else this.hiddenCols.add(k);
          this._renderHead();
          this._renderBody();
        };
      });
    }

    _visibleCols() {
      return this.columns.filter((c) => !this.hiddenCols.has(c.key));
    }

    /* ---------------- 表头 ---------------- */
    _renderHead() {
      const cols = this._visibleCols();
      const allChecked = this.list.length > 0 && this.list.every((r) => this.selected.has(this._rowKey(r)));
      this.el.head.innerHTML = '<tr>' + cols.map((c) => {
        const sorted = this.sortKey === c.key;
        const cls = [c.sortable ? 'sortable' : '', sorted ? 'sorted' : '', c.key === '_check' ? 'col-check' : '']
          .filter(Boolean).join(' ');
        const style = c.width ? `width:${c.width};` : '';
        const align = c.align ? `text-align:${c.align};` : '';
        let inner = c.label || '';
        if (c.key === '_check') {
          inner = `<input type="checkbox" data-role="check-all" ${allChecked ? 'checked' : ''} />`;
        } else if (c.sortable) {
          const ico = sorted ? (this.sortDir === 'asc' ? '▲' : '▼') : '⇅';
          inner += ` <span class="sort-ico">${ico}</span>`;
        }
        return `<th class="${cls}" style="${style}${align}" data-key="${c.key}">${inner}</th>`;
      }).join('') + '</tr>';

      const checkAll = this.el.head.querySelector('[data-role="check-all"]');
      if (checkAll) {
        checkAll.onchange = () => {
          if (checkAll.checked) this.list.forEach((r) => this.selected.add(this._rowKey(r)));
          else this.selected.clear();
          this._renderHead();
          this._renderBody();
          this._renderBatch();
        };
      }

      this.el.head.querySelectorAll('th.sortable').forEach((th) => {
        th.onclick = () => this._toggleSort(th.dataset.key);
      });
    }

    _toggleSort(key) {
      if (this.sortKey !== key) {
        this.sortKey = key;
        this.sortDir = 'asc';
      } else if (this.sortDir === 'asc') {
        this.sortDir = 'desc';
      } else {
        this.sortKey = null;
        this.sortDir = null;
      }
      this.page = 1;
      this.reload();
    }

    /* ---------------- 表体 ---------------- */
    _renderBody() {
      const cols = this._visibleCols();

      if (this.loading) {
        this.el.body.innerHTML = `<tr><td colspan="${cols.length}" style="padding:0;border:none">
          <div class="skeleton">${'<div class="sk-row"></div>'.repeat(6)}</div>
        </td></tr>`;
        return;
      }

      if (!this.list.length) {
        this.el.body.innerHTML = `<tr><td colspan="${cols.length}" style="padding:0;border:none">
          <div class="empty-page" style="padding:56px 0">
            <div class="big">${this.opt.emptyIcon || '📭'}</div>
            <div>${this.opt.emptyText || '暂无数据'}</div>
            ${this.opt.emptyHint ? `<div class="muted">${this.opt.emptyHint}</div>` : ''}
          </div>
        </td></tr>`;
        return;
      }

      this.el.body.innerHTML = this.list.map((row) => {
        const k = this._rowKey(row);
        const isSel = this.selected.has(k);
        return `<tr class="${isSel ? 'selected' : ''}" data-key="${escAttr(k)}">`
          + cols.map((c) => {
            if (c.key === '_check') {
              return `<td class="col-check"><input type="checkbox" data-role="check" ${isSel ? 'checked' : ''} /></td>`;
            }
            const style = c.align ? `text-align:${c.align};` : '';
            const content = c.render ? c.render(row) : (row[c.key] == null ? '' : escapeHtml(row[c.key]));
            return `<td style="${style}">${content}</td>`;
          }).join('')
          + '</tr>';
      }).join('');

      this.el.body.querySelectorAll('tr[data-key]').forEach((tr) => {
        const key = tr.dataset.key;

        const chk = tr.querySelector('[data-role="check"]');
        if (chk) {
          chk.onclick = (e) => {
            e.stopPropagation();
            if (chk.checked) this.selected.add(key);
            else this.selected.delete(key);
            tr.classList.toggle('selected', chk.checked);
            this._renderBatch();
            this._syncCheckAll();
          };
        }

        if (this.opt.onRowClick) {
          tr.onclick = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.act-link')) return;
            const row = this.list.find((r) => String(this._rowKey(r)) === key);
            if (row) this.opt.onRowClick(row);
          };
        }

        // 行内操作按钮
        tr.querySelectorAll('[data-row-act]').forEach((btn) => {
          btn.onclick = (e) => {
            e.stopPropagation();
            const row = this.list.find((r) => String(this._rowKey(r)) === key);
            const act = btn.dataset.rowAct;
            const handler = (this.opt.rowActions || {})[act];
            if (row && handler) handler(row, this, e);
          };
        });
      });
    }

    _syncCheckAll() {
      const chk = this.el.head.querySelector('[data-role="check-all"]');
      if (!chk) return;
      chk.checked = this.list.length > 0 && this.list.every((r) => this.selected.has(this._rowKey(r)));
    }

    /* ---------------- 批量栏 ---------------- */
    _renderBatch() {
      const bar = this.el.batch;
      const n = this.selected.size;
      if (!n) { bar.classList.remove('show'); bar.innerHTML = ''; return; }

      const actions = this.opt.batchActions || [];
      bar.classList.add('show');
      bar.innerHTML = `<span>已选择 <span class="count">${n}</span> 项</span>`
        + actions.map((a, i) => `<button class="act-link ${a.danger ? 'danger' : ''}" data-batch="${i}">${a.label}</button>`).join('')
        + '<button class="act-link" data-batch="clear" style="margin-left:auto">取消选择</button>';

      bar.querySelectorAll('[data-batch]').forEach((btn) => {
        btn.onclick = () => {
          const idx = btn.dataset.batch;
          if (idx === 'clear') {
            this.selected.clear();
            this._renderHead();
            this._renderBody();
            this._renderBatch();
            return;
          }
          const action = actions[Number(idx)];
          if (!action) return;
          const rows = this.list.filter((r) => this.selected.has(this._rowKey(r)));
          action.onClick(rows, this);
        };
      });
    }

    /* ---------------- 分页 ---------------- */
    _renderPager() {
      const totalPages = Math.max(1, Math.ceil(this.total / this.pageSize));
      const p = this.page;
      const pages = [];
      const push = (v) => pages.push(v);

      if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) push(i);
      } else {
        push(1);
        if (p > 3) push('...');
        for (let i = Math.max(2, p - 1); i <= Math.min(totalPages - 1, p + 1); i++) push(i);
        if (p < totalPages - 2) push('...');
        push(totalPages);
      }

      const sizeOpts = this.opt.pageSizeOptions || [20, 50, 100];
      this.el.pager.innerHTML = `
        <span>共 <b>${this.total}</b> 条</span>
        <div class="pages">
          <button class="pg" data-pg="prev" ${p <= 1 ? 'disabled' : ''}>‹</button>
          ${pages.map((v) => v === '...'
            ? '<span class="pg" style="border:none;background:none;cursor:default">…</span>'
            : `<button class="pg ${v === p ? 'on' : ''}" data-pg="${v}">${v}</button>`).join('')}
          <button class="pg" data-pg="next" ${p >= totalPages ? 'disabled' : ''}>›</button>
          <select data-role="pagesize" style="height:28px;font-size:12px;margin-left:8px">
            ${sizeOpts.map((s) => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s} 条/页</option>`).join('')}
          </select>
        </div>
      `;

      this.el.pager.querySelectorAll('[data-pg]').forEach((btn) => {
        btn.onclick = () => {
          const v = btn.dataset.pg;
          if (v === 'prev') this.page = Math.max(1, this.page - 1);
          else if (v === 'next') this.page = Math.min(totalPages, this.page + 1);
          else this.page = Number(v);
          this.reload();
        };
      });

      const sel = this.el.pager.querySelector('[data-role="pagesize"]');
      if (sel) {
        sel.onchange = () => {
          this.pageSize = Number(sel.value);
          this.page = 1;
          this.reload();
        };
      }
    }

    /* ---------------- 数据加载 ---------------- */
    async reload() {
      this.loading = true;
      this._renderHead();
      this._renderBody();

      try {
        const res = await this.opt.fetch({
          page: this.page,
          pageSize: this.pageSize,
          sortKey: this.sortKey,
          sortDir: this.sortDir,
        });
        this.list = res.list || [];
        this.total = res.total != null ? res.total : this.list.length;
        // 清理已不存在的选中项
        const keys = new Set(this.list.map((r) => this._rowKey(r)));
        for (const k of [...this.selected]) if (!keys.has(k)) this.selected.delete(k);
      } catch (e) {
        console.error('[DataTable] 加载失败', e);
        this.list = [];
        this.total = 0;
      }

      this.loading = false;
      this._renderHead();
      this._renderBody();
      this._renderBatch();
      this._renderPager();
      this._syncCheckAll();

      if (this.el.sub) {
        this.el.sub.textContent = this.total ? `${this.total} 条记录` : '';
      }
      if (this.opt.onLoaded) this.opt.onLoaded(this);
      window.UI.syncStatusTabs();
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escAttr(s) { return escapeHtml(s); }

  window.DataTable = DataTable;
})();
