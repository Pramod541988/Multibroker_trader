'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Table, Tabs, Tab, Badge, Modal, Form, Spinner, InputGroup } from 'react-bootstrap';
import api from './api';

// --- Inline icons (no external package) ---
const SearchIcon = (props) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </svg>
);
const XCircle = (props) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="15" y1="9" x2="9" y2="15"></line>
    <line x1="9" y1="9" x2="15" y2="15"></line>
  </svg>
);

const AUTO_REFRESH_MS = 3000;

const DISPLAY_TO_CANON = {
  NO_CHANGE: 'NO_CHANGE',
  LIMIT: 'LIMIT',
  MARKET: 'MARKET',
  STOPLOSS: 'STOPLOSS',
  'SL MARKET': 'STOPLOSS_MARKET',
};

export default function Orders() {
  const [orders, setOrders] = useState({ pending: [], traded: [], rejected: [], cancelled: [], others: [] });
  const [selectedIds, setSelectedIds] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);

  // search
  const [query, setQuery] = useState('');
  const qTokens = useMemo(
    () => query.trim().split(/\s+/).filter(Boolean),
    [query]
  );

  // modify modal
  const [showModify, setShowModify] = useState(false);
  const [modifyTarget, setModifyTarget] = useState(null);
  const [modQty, setModQty] = useState('');
  const [modPrice, setModPrice] = useState('');
  const [modTrig, setModTrig] = useState('');
  const [modType, setModType] = useState('NO_CHANGE');
  const [modLTP, setModLTP] = useState('—');
  const [modSaving, setModSaving] = useState(false);

  const busyRef = useRef(false);
  const snapRef = useRef('');
  const timerRef = useRef(null);
  const abortRef = useRef(null);

  const fetchAll = async () => {
    if (busyRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await api.get('/get_orders', { signal: controller.signal });
      const next = {
        pending: res.data?.pending || [],
        traded: res.data?.traded || [],
        rejected: res.data?.rejected || [],
        cancelled: res.data?.cancelled || [],
        others: res.data?.others || [],
      };
      const snap = JSON.stringify(next);
      if (snap !== snapRef.current) {
        snapRef.current = snap;
        setOrders(next);
        setLastUpdated(new Date());
      }
    } catch (e) {
      if (e.name !== 'CanceledError' && e.code !== 'ERR_CANCELED') {
        console.warn('orders refresh failed', e?.message || e);
      }
    } finally {
      abortRef.current = null;
    }
  };

  useEffect(() => {
    fetchAll().catch(() => {});
    timerRef.current = setInterval(() => { fetchAll().catch(() => {}); }, AUTO_REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const toggle = (rowId) => setSelectedIds((prev) => ({ ...prev, [rowId]: !prev[rowId] }));

  // Cancel
  const cancelSelected = async () => {
    const rows = document.querySelectorAll('#pending_table tbody tr');
    const selectedOrders = [];
    rows.forEach((tr) => {
      const rowId = tr.getAttribute('data-rowid');
      if (selectedIds[rowId]) {
        const tds = tr.querySelectorAll('td');
        selectedOrders.push({
          name: tds[1]?.textContent.trim(),
          symbol: tds[2]?.textContent.trim(),
          order_id: tds[7]?.textContent.trim(),
        });
      }
    });
    if (selectedOrders.length === 0) return alert('No orders selected.');

    try {
      busyRef.current = true;
      const res = await api.post('/cancel_order', { orders: selectedOrders });
      alert(Array.isArray(res.data?.message) ? res.data.message.join('\n') : 'Cancel request sent');
      setSelectedIds({});
      await fetchAll();
    } catch (e) {
      alert('Cancel failed: ' + (e.response?.data || e.message));
    } finally {
      busyRef.current = false;
    }
  };

  // Modify helpers
  const requires = (displayType) => {
    const canon = DISPLAY_TO_CANON[displayType] || displayType;
    return {
      price: ['LIMIT', 'STOPLOSS'].includes(canon),
      trig: ['STOPLOSS', 'STOPLOSS_MARKET'].includes(canon),
      canon,
    };
  };

  const tryFetchLTP = async (symbol) => {
    try {
      const r = await api.get('/ltp', { params: { symbol } });
      const v = Number(r?.data?.ltp);
      if (!Number.isNaN(v)) setModLTP(v.toFixed(2));
    } catch {}
  };

  const openModify = () => {
    const rows = document.querySelectorAll('#pending_table tbody tr');
    const chosen = [];
    rows.forEach((tr) => {
      const rowId = tr.getAttribute('data-rowid');
      if (selectedIds[rowId]) {
        const tds = tr.querySelectorAll('td');
        chosen.push({
          name: tds[1]?.textContent.trim(),
          symbol: tds[2]?.textContent.trim(),
          price: tds[5]?.textContent.trim(),
          order_id: tds[7]?.textContent.trim(),
        });
      }
    });

    if (chosen.length === 0) return alert('Select one pending order to modify.');
    if (chosen.length > 1) return alert('Please select only one order to modify.');

    const row = chosen[0];
    setModifyTarget({ name: row.name, symbol: row.symbol, order_id: row.order_id });
    const p = parseFloat(row.price);
    setModPrice(!Number.isNaN(p) && p > 0 ? String(p) : '');
    setModTrig('');
    setModQty('');
    setModType('NO_CHANGE');
    setModLTP('—');
    setShowModify(true);
    if (row.symbol) tryFetchLTP(row.symbol);
  };

  const submitModify = async () => {
    if (!modifyTarget) return;

    const need = requires(modType);
    let qtyNum, priceNum, trigNum;

    if (modQty !== '') {
      qtyNum = parseInt(modQty, 10);
      if (Number.isNaN(qtyNum) || qtyNum <= 0) return alert('Quantity must be a positive integer.');
    }
    if (modPrice !== '') {
      priceNum = parseFloat(modPrice);
      if (Number.isNaN(priceNum) || priceNum <= 0) return alert('Price must be a positive number.');
    }
    if (modTrig !== '') {
      trigNum = parseFloat(modTrig);
      if (Number.isNaN(trigNum) || trigNum <= 0) return alert('Trigger price must be a positive number.');
    }

    if (modType !== 'NO_CHANGE') {
      if (need.price && !(modPrice !== '' && priceNum > 0)) return alert('Selected Order Type requires Price.');
      if (need.trig && !(modTrig !== '' && trigNum > 0)) return alert('Selected Order Type requires Trigger Price.');
    }

    if (modType === 'NO_CHANGE' && modQty === '' && modPrice === '' && modTrig === '') {
      return alert('Nothing to update. Change Qty / Price / Trigger Price / Order Type.');
    }

    const payload = { ...modifyTarget };
    if (modType !== 'NO_CHANGE') payload.ordertype = need.canon;
    if (modQty !== '') payload.quantity = qtyNum;
    if (modPrice !== '') payload.price = priceNum;
    if (modTrig !== '') payload.triggerprice = trigNum;

    try {
      busyRef.current = true;
      setModSaving(true);
      const res = await api.post('/modify_order', { order: payload });
      const msg = res.data?.message || 'Modify request sent';
      alert(Array.isArray(msg) ? msg.join('\n') : msg);
      setShowModify(false);
      setSelectedIds({});
      await fetchAll();
    } catch (e) {
      alert('Modify failed: ' + (e.response?.data || e.message));
    } finally {
      setModSaving(false);
      busyRef.current = false;
    }
  };

  // search helpers (symbol only)
  const filterBySymbol = (rows) => {
    if (qTokens.length === 0) return rows;
    return rows.filter((r) => {
      const sym = String(r.symbol || '').toUpperCase();
      return qTokens.every((t) => sym.includes(t.toUpperCase()));
    });
  };

  const filtered = {
    pending: filterBySymbol(orders.pending),
    traded: filterBySymbol(orders.traded),
    rejected: filterBySymbol(orders.rejected),
    cancelled: filterBySymbol(orders.cancelled),
    others: filterBySymbol(orders.others),
  };

  const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const highlightSymbol = (sym) => {
    const text = sym ?? 'N/A';
    if (!text || qTokens.length === 0) return text;
    try {
      const re = new RegExp(`(${qTokens.map(escapeReg).join('|')})`, 'gi');
      const parts = String(text).split(re);
      return parts.map((p, i) =>
        re.test(p) ? (
          <mark key={i} className="hl">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      );
    } catch {
      return text;
    }
  };

  const renderTable = (rows, id) => (
    <Table bordered hover size="sm" id={id}>
      <thead>
        <tr>
          <th>Select</th>
          <th>Name</th>
          <th>Symbol</th>
          <th>Type</th>
          <th>Qty</th>
          <th>Price</th>
          <th>Status</th>
          <th>Order ID</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={8} className="text-center">No data</td></tr>
        ) : (
          rows.map((row, idx) => {
            const rowId = `${row.name}-${row.symbol}-${row.order_id || row.status || idx}`;
            return (
              <tr key={rowId} data-rowid={rowId}>
                <td><input type="checkbox" checked={!!selectedIds[rowId]} onChange={() => toggle(rowId)} /></td>
                <td>{row.name ?? 'N/A'}</td>
                <td>{highlightSymbol(row.symbol)}</td>
                <td>{row.transaction_type ?? 'N/A'}</td>
                <td>{row.quantity ?? 'N/A'}</td>
                <td>{row.price ?? 'N/A'}</td>
                <td>{row.status ?? 'N/A'}</td>
                <td>{row.order_id ?? 'N/A'}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </Table>
  );

  return (
    <Card className="p-3 softCard">
      <div className="mb-3 d-flex gap-2 align-items-center flex-wrap">
        <Button onClick={() => fetchAll()}>Refresh Orders</Button>
        <Button variant="warning" onClick={openModify}>Modify Order</Button>
        <Button variant="danger" onClick={cancelSelected}>Cancel Order</Button>

        {/* Search by Symbol */}
        <div className="ms-auto">
          <InputGroup className="searchGroup">
            <InputGroup.Text title="Search by Symbol"><SearchIcon /></InputGroup.Text>
            <Form.Control
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
              placeholder="Search symbol (e.g., RELIANCE)"
              aria-label="Search by symbol"
            />
            {query ? (
              <Button variant="outline-secondary" onClick={() => setQuery('')} title="Clear">
                <XCircle />
              </Button>
            ) : null}
          </InputGroup>
        </div>

        <Badge bg="secondary" className="ms-2">
          Auto-refresh: {Math.round(AUTO_REFRESH_MS / 1000)}s {lastUpdated ? `· Updated ${lastUpdated.toLocaleTimeString()}` : ''}
        </Badge>
      </div>

      <Tabs defaultActiveKey="pending" className="mb-3">
        <Tab eventKey="pending" title="Pending">{renderTable(filtered.pending, 'pending_table')}</Tab>
        <Tab eventKey="traded" title="Traded">{renderTable(filtered.traded, 'traded_table')}</Tab>
        <Tab eventKey="rejected" title="Rejected">{renderTable(filtered.rejected, 'rejected_table')}</Tab>
        <Tab eventKey="cancelled" title="Cancelled">{renderTable(filtered.cancelled, 'cancelled_table')}</Tab>
        <Tab eventKey="others" title="Others">{renderTable(filtered.others, 'others_table')}</Tab>
      </Tabs>

      {/* Local styles */}
      <style jsx global>{`
        .softCard { border: 1px solid #e6efff; box-shadow: 0 2px 12px rgba(13,110,253,.06); border-radius: 12px; }
        .searchGroup { min-width: 280px; max-width: 360px; }
        .searchGroup .input-group-text { background: #eaf3ff; border-color: #cfe2ff; }
        .searchGroup .form-control { border-color: #cfe2ff; }
        .searchGroup .btn { border-color: #cfe2ff; }
        mark.hl { background: #fff3cd; padding: 0 2px; border-radius: 2px; }
      `}</style>
    </Card>
  );
}
