const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const preference = new Preference(client);

const app = express();

// --- 1. CONFIGURAÇÕES DE SEGURANÇA (HEADERS & CORS) ---
app.use(helmet()); 

app.get('/api/ping', (req, res) => res.send('pong'));
const corsOptions = {
    origin: function (origin, callback) {
        // Permitir tudo momentaneamente para resolver o erro de conexão do usuário
        callback(null, true);
    },
    credentials: true,
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// Logger para depuração
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- 2. RATE LIMITING ---
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 10, 
    message: { success: false, message: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 60, 
    message: { success: false, message: 'Limite de requisições excedido.' }
});

// --- 3. INICIALIZAÇÃO CLIENTS ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 4. MIDDLEWARE DE AUTENTICAÇÃO JWT ---
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ success: false, message: 'Token inválido' });
            req.user = user;
            next();
        });
    } else {
        res.status(401).json({ success: false, message: 'Token não fornecido' });
    }
};

// --- 5. AUTH ENDPOINTS ---
app.post('/api/login', authLimiter, async (req, res) => {
    const { user, pass } = req.body;
    const { data, error } = await supabase.from('users').select('*').eq('username', user).eq('password', pass).single();

    if (error || !data) return res.status(401).json({ success: false, message: 'Usuário ou senha incorretos' });
    
    const token = jwt.sign({ id: data.id, username: data.username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.json({ success: true, token });
});

app.post('/api/register', authLimiter, async (req, res) => {
    const { user, pass } = req.body;
    const { data: existingUser } = await supabase.from('users').select('id').eq('username', user).single();
    if (existingUser) return res.status(400).json({ success: false, message: 'Usuário já existe' });

    const { error } = await supabase.from('users').insert([{ username: user, password: pass }]);
    if (error) return res.status(500).json(error);
    res.json({ success: true, message: 'Pronto! Cadastrado.' });
});

// --- 6. SALES & STRIPE CHECKOUT ---

app.get('/api/sales', apiLimiter, authenticateJWT, async (req, res) => {
    const { data, error } = await supabase.from('sales').select('*').eq('user_id', req.user.id).order('date', { ascending: false });
    if (error) return res.status(500).json(error);
    res.json(data);
});

app.post('/api/sales', apiLimiter, authenticateJWT, async (req, res) => {
    const { customer, items, payment_method, installments } = req.body;
    
    let totalCalculated = 0;
    const lineItems = [];
    const { data: dbProducts } = await supabase.from('products').select('*');
    
    for (const item of items) {
        const product = dbProducts.find(p => p.name === item.name);
        if (product) {
            const priceInCents = Math.round(parseFloat(product.price) * 100);
            totalCalculated += parseFloat(product.price);
            lineItems.push({
                price_data: {
                    currency: 'brl',
                    product_data: { name: product.name },
                    unit_amount: priceInCents,
                },
                quantity: 1,
            });
        }
    }

    const { data, error } = await supabase.from('sales').insert([{
        customer,
        items,
        total: totalCalculated,
        payment_method,
        installments,
        user_id: req.user.id,
        status1: 'Pendente',
        date: new Date().toISOString()
    }]).select();

    if (error) return res.status(500).json(error);
    const sale = data[0];

    // Criar Preferência do Mercado Pago
    try {
        const body = {
            items: lineItems.map(item => ({
                id: sale.id,
                title: item.price_data.product_data.name,
                unit_price: item.price_data.unit_amount / 100, // MP espera em reais, não centavos
                quantity: item.quantity,
                currency_id: 'BRL'
            })),
            back_urls: {
                success: `${process.env.ALLOWED_ORIGIN}?success=true`,
                failure: `${process.env.ALLOWED_ORIGIN}?canceled=true`,
                pending: `${process.env.ALLOWED_ORIGIN}?pending=true`
            },
            auto_return: 'approved',
            metadata: { sale_id: sale.id },
            // notification_url: `${process.env.BACKEND_URL}/api/webhooks/mercadopago`,
            payer: {
                email: 'test_user_123@testuser.com' 
            }
        };

        const response = await preference.create({ body });
        res.json({ success: true, checkout_url: response.init_point, sale });
    } catch (e) {
        console.error('Erro MP Detalhado (Venda):', JSON.stringify(e, null, 2));
        res.status(500).json({ error: e.message });
    }
});

// --- 7. MERCADO PAGO WEBHOOK ---
app.post('/api/webhooks/mercadopago', async (req, res) => {
    const { type, data } = req.body;

    try {
        if (type === 'payment') {
            const paymentId = data.id;
            // Buscar detalhes do pagamento no MP
            const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
            });
            const paymentData = await paymentResponse.json();

            if (paymentData.status === 'approved') {
                const saleId = paymentData.metadata.sale_id;

                await supabase
                    .from('sales')
                    .update({ status1: 'Pago' })
                    .eq('id', saleId);
                
                console.log(`Venda ${saleId} marcada como Paga via Mercado Pago.`);
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook MP Error:', err.message);
        res.status(500).send(`Webhook Error: ${err.message}`);
    }
});

app.patch('/api/sales/:id', authenticateJWT, async (req, res) => {
    const { id } = req.params;
    const { field, value } = req.body;
    const { error } = await supabase.from('sales').update({ [field]: value }).eq('id', id).eq('user_id', req.user.id);
    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

app.delete('/api/sales/:id', authenticateJWT, async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('sales').delete().eq('id', id).eq('user_id', req.user.id);
    if (error) return res.status(500).json(error);
    res.json({ success: true });
});

// --- 8. SUBSCRIPTION ENDPOINT (Stripe) ---

app.post('/api/subscribe', apiLimiter, authenticateJWT, async (req, res) => {
    try {
        const body = {
            items: [{
                id: 'sub_monthly',
                title: 'Plano Elegance Flex (Mensal)',
                description: 'Controle de vendas, cadastro de vendas, monitorar pagamentos e outros.',
                unit_price: 2.00,
                quantity: 1,
                currency_id: 'BRL'
            }],
            back_urls: {
                success: `${process.env.ALLOWED_ORIGIN}?success=subscription`,
                failure: `${process.env.ALLOWED_ORIGIN}?canceled=subscription`,
                pending: `${process.env.ALLOWED_ORIGIN}?pending=subscription`
            },
            auto_return: 'approved',
            metadata: { user_id: req.user.id, type: 'subscription' },
            // notification_url: `${process.env.BACKEND_URL}/api/webhooks/mercadopago`,
            payer: {
                email: 'test_user_123@testuser.com'
            }
        };

        const response = await preference.create({ body });
        res.json({ success: true, checkout_url: response.init_point });
    } catch (e) {
        console.error('Erro MP Detalhado (Assinatura):', JSON.stringify(e, null, 2));
        res.status(500).json({ error: e.message || 'Erro interno no servidor' });
    }
});

// Para rodar localmente (Vercel não usa isso)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🛡️  Backend ELEGANCE: http://0.0.0.0:${PORT}`);
    });
}

module.exports = app;
