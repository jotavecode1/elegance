document.addEventListener('DOMContentLoaded', async () => {
    // --- BACKEND CONFIG ---
    const API_URL = 'http://localhost:3000/api';

    // --- LOGIN & REGISTER & CHANGE PASS TOGGLE ---
    const loginView = document.getElementById('login-view');
    const registerView = document.getElementById('register-view');
    const changePassView = document.getElementById('change-pass-view');
    
    const showRegister = document.getElementById('show-register');
    const showLogin = document.getElementById('show-login');
    const showChangePass = document.getElementById('show-change-password');
    const showLoginFromCP = document.getElementById('show-login-from-cp');

    const toggleViews = (toShow) => {
        [loginView, registerView, changePassView].forEach(v => v.style.display = 'none');
        toShow.style.display = 'block';
    };

    showRegister.addEventListener('click', (e) => { e.preventDefault(); toggleViews(registerView); });
    showLogin.addEventListener('click', (e) => { e.preventDefault(); toggleViews(loginView); });
    showChangePass.addEventListener('click', (e) => { e.preventDefault(); toggleViews(changePassView); });
    showLoginFromCP.addEventListener('click', (e) => { e.preventDefault(); toggleViews(loginView); });

    // 0. Auth Elements
    const loginScreen = document.getElementById('login-screen');
    const mainContent = document.getElementById('main-content');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const changePassForm = document.getElementById('change-pass-form');

    const loginError = document.getElementById('login-error');
    const registerError = document.getElementById('register-error');
    const cpError = document.getElementById('cp-error');
    const cpSuccess = document.getElementById('cp-success');

    // Ao carregar a página (Refresh), sempre volta para o login para segurança
    const clearAuth = () => {
        sessionStorage.removeItem('elegance_token');
        loginScreen.style.display = 'flex';
        mainContent.style.display = 'none';
        loginScreen.style.opacity = '1';
    };
    clearAuth();

    // Utilitário para Headers com Token
    const getHeaders = () => {
        const token = sessionStorage.getItem('elegance_token');
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        };
    };

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = document.getElementById('username').value;
        const pass = document.getElementById('password').value;

        try {
            const response = await fetch(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, pass })
            });

            const result = await response.json();

            if (result.success) {
                sessionStorage.setItem('elegance_token', result.token);
                loginScreen.style.opacity = '0';
                setTimeout(() => {
                    loginScreen.style.display = 'none';
                    mainContent.style.display = 'flex';
                    fetchSales();
                }, 300);
            } else {
                loginError.textContent = result.message;
                setTimeout(() => { loginError.textContent = ''; }, 3000);
            }
        } catch (error) {
            loginError.textContent = 'Erro de conexão.';
        }
    });

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = document.getElementById('reg-username').value;
        const pass = document.getElementById('reg-password').value;

        try {
            const response = await fetch(`${API_URL}/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, pass })
            });
            const result = await response.json();
            if (result.success) {
                alert('Cadastrado com sucesso!');
                showLogin.click();
            } else {
                registerError.textContent = result.message;
            }
        } catch (error) { registerError.textContent = 'Erro de conexão.'; }
    });

    // 1. UI Elements Dashboard
    const salesForm = document.getElementById('sales-form');
    const itemsContainer = document.getElementById('items-container');
    const addItemBtn = document.getElementById('add-item');
    const formTotalDisplay = document.getElementById('form-total-value');
    const salesList = document.getElementById('sales-list');
    
    const statTotal = document.getElementById('stat-total');
    const statCommission = document.getElementById('stat-commission');
    const statRepasse = document.getElementById('stat-repasse');
    
    let sales = [];

    const createItemRow = () => {
        const row = document.createElement('div');
        row.className = 'item-row';
        row.innerHTML = `
            <select class="product-select" required>
                <option value="" disabled selected>Produto</option>
                <option value="Brinco">Brinco</option>
                <option value="Colar">Colar</option>
                <option value="Pulseira">Pulseira</option>
                <option value="Pingente">Pingente</option>
                <option value="Anel">Anel</option>
            </select>
            <input type="number" class="product-amount" step="0.01" placeholder="Preço" disabled>
            <button type="button" class="btn-remove-item">&times;</button>
        `;
        
        // Simulação de preço no front (o real é no back)
        const prices = { 'Brinco': 50, 'Colar': 120, 'Pulseira': 85, 'Pingente': 45, 'Anel': 95 };
        row.querySelector('.product-select').addEventListener('change', (e) => {
            row.querySelector('.product-amount').value = prices[e.target.value] || 0;
            calculateFormTotal();
        });

        row.querySelector('.btn-remove-item').addEventListener('click', () => { row.remove(); calculateFormTotal(); });
        return row;
    };

    addItemBtn.addEventListener('click', () => itemsContainer.appendChild(createItemRow()));

    function calculateFormTotal() {
        let total = 0;
        itemsContainer.querySelectorAll('.product-amount').forEach(input => {
            total += parseFloat(input.value) || 0;
        });
        formTotalDisplay.textContent = formatCurrency(total);
    }

    function formatCurrency(value) {
        return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
    }

    const fetchSales = async () => {
        try {
            const response = await fetch(`${API_URL}/sales`, { headers: getHeaders() });
            if (response.status === 403) return logout();
            sales = await response.json();
            updateUI();
        } catch (error) { console.error('Error fetching sales:', error); }
    };

    const updateUI = () => {
        salesList.innerHTML = '';
        let totalGlobal = 0;

        sales.forEach((sale, index) => {
            totalGlobal += parseFloat(sale.total);
            const row = document.createElement('tr');
            const dateStr = sale.date ? new Date(sale.date).toLocaleString('pt-BR') : 'N/A';

            const productsHtml = sale.items.map(item => `
                <div class="product-item"><span>${item.name}</span><strong>${formatCurrency(item.price)}</strong></div>
            `).join('');

            row.innerHTML = `
                <td><div class="customer-info"><strong>${sale.customer}</strong><span class="sale-date">${dateStr}</span></div></td>
                <td><div class="products-cell">${productsHtml}</div></td>
                <td><strong>${formatCurrency(sale.total)}</strong></td>
                <td>${sale.payment_method} (${sale.installments}x)</td>
                <td>
                    <select class="status-select ${sale.status1.toLowerCase()}" data-field="status1" data-id="${sale.id}">
                        <option value="Pendente" ${sale.status1 === 'Pendente' ? 'selected' : ''}>Pendente</option>
                        <option value="Pago" ${sale.status1 === 'Pago' ? 'selected' : ''}>Pago</option>
                    </select>
                </td>
                <td>
                    ${sale.installments == '2' ? `
                        <select class="status-select ${sale.status2.toLowerCase()}" data-field="status2" data-id="${sale.id}">
                            <option value="Pendente" ${sale.status2 === 'Pendente' ? 'selected' : ''}>Pendente</option>
                            <option value="Pago" ${sale.status2 === 'Pago' ? 'selected' : ''}>Pago</option>
                        </select>
                    ` : '<span style="color:#ccc">-</span>'}
                </td>
                <td>
                    <div class="action-btns">
                        <button class="btn-delete" data-id="${sale.id}" data-index="${index}">Remover</button>
                    </div>
                </td>
            `;
            salesList.appendChild(row);
        });

        statTotal.textContent = formatCurrency(totalGlobal);
        statCommission.textContent = formatCurrency(totalGlobal * 0.4);
        statRepasse.textContent = formatCurrency(totalGlobal * 0.6);

        attachRowEvents();
    };

    const attachRowEvents = () => {
        document.querySelectorAll('.status-select').forEach(sel => {
            sel.addEventListener('change', async (e) => {
                const { id, field } = e.target.dataset;
                const value = e.target.value;
                try {
                    await fetch(`${API_URL}/sales/${id}`, {
                        method: 'PATCH',
                        headers: getHeaders(),
                        body: JSON.stringify({ field, value })
                    });
                    fetchSales();
                } catch (error) { console.error('Error updating status:', error); }
            });
        });

        document.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if(confirm('Remover venda?')) {
                    const id = e.target.dataset.id;
                    try {
                        await fetch(`${API_URL}/sales/${id}`, { method: 'DELETE', headers: getHeaders() });
                        fetchSales();
                    } catch (error) { alert('Erro ao remover.'); }
                }
            });
        });
    };

    salesForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = salesForm.querySelector('button[type="submit"]');
        const items = [];
        itemsContainer.querySelectorAll('.item-row').forEach(row => {
            const name = row.querySelector('.product-select').value;
            if (name) items.push({ name }); // Backend recalcula preço
        });

        if (items.length === 0) return alert('Adicione ao menos um produto.');

        const saleData = {
            customer: document.getElementById('customer').value,
            items,
            payment_method: document.getElementById('payment-method').value,
            installments: parseInt(document.getElementById('installments').value)
        };

        btn.textContent = 'Processando...';
        btn.disabled = true;

        try {
            const response = await fetch(`${API_URL}/sales`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify(saleData)
            });
            if (response.ok) {
                salesForm.reset();
                itemsContainer.innerHTML = '';
                addItemBtn.click();
                fetchSales();
            }
        } catch (error) { alert('Erro ao salvar.'); }
        finally {
            btn.textContent = 'Registrar Venda';
            btn.disabled = false;
        }
    });

    const logout = () => { clearAuth(); };
    document.getElementById('logout-btn').addEventListener('click', logout);

    document.getElementById('open-contact').addEventListener('click', () => document.getElementById('modal').classList.add('active'));
    document.getElementById('modal-close').addEventListener('click', () => document.getElementById('modal').classList.remove('active'));
});
