import { VercelRequest, VercelResponse } from '@vercel/node';
import express from 'express';
import routes from '../src/api/routes';
import cors from 'cors';
import path from 'path';

// Create Express app
const app = express();

// Middleware
app.use(cors()); // Enable CORS
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Parse URL-encoded bodies

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api', routes);

// Root endpoint
app.get('/', (req, res) => {
    const baseUrl = `https://${req.headers.host}`;

    res.json({
        name: 'stS helper API',
        version: '1.0.0',
        description: 'API for validator staking/unstaking recommendations and delegation boost calculations',
        endpoints: {
            unstakeRecommendation: `${baseUrl}/api/unstake-recommendation?amount=1000000000000000000`,
            stakeRecommendation: `${baseUrl}/api/stake-recommendation`,
        },
        documentation: {
            '/api/unstake-recommendation?amount=X':
                'Calculate optimal withdrawal recommendations for the specified amount in wei',
            '/api/stake-recommendation': 'Get delegation analysis and staking recommendations',
        },
        timestamp: new Date().toISOString(),
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        timestamp: Date.now(),
    });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        timestamp: Date.now(),
    });
});

// Start server
// app.listen(3000, () => {
//     console.log(`🚀 stS helper running on port 3000`);
//     console.log(`📊 API endpoints available at http://localhost:3000/api`);
// });

// Export Vercel handler
export default (req: VercelRequest, res: VercelResponse) => {
    return app(req as any, res as any);
};
